/* =================================================================
   providers/hetzner.js — Hetzner Cloud
   -----------------------------------------------------------------
   Only reached by the scheduler in Phase 5. For the first ten
   clients the platform runs on ONE server that already exists, and
   the important cost rule is that a deployment never creates a VM —
   ten clients means ten containers on one box, not ten boxes.

   The token is read from the environment on every call rather than
   captured at import, so rotating it does not need a restart, and it
   is never written to a log line even on an error path.

   Every server this creates is tagged with labels the platform can
   filter on, so a stray API call can never delete something that was
   not created here.
   ================================================================= */
"use strict";

const { cfg } = require("../config");

const API = "https://api.hetzner.cloud/v1";

function token() {
  const t = (process.env.HETZNER_TOKEN || cfg.hetzner.token || "").trim();
  if (!t) throw new Error("HETZNER_TOKEN is not set");
  return t;
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: "Bearer " + token(),
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Deliberately does not include the request body or headers: a failed
    // create call would otherwise print cloud-init containing secrets.
    const msg = (json && json.error && json.error.message) || res.statusText;
    throw new Error("hetzner " + method + " " + path + " failed (" + res.status + "): " + msg);
  }
  return json;
}

/**
 * cloud-init for a fresh deployment host.
 *
 * Hetzner publishes a docker-ce image with Docker and Compose already
 * installed, which is why the image default in config is docker-ce — this
 * script then only has to harden the box, not build it.
 */
function userData() {
  return [
    "#cloud-config",
    "package_update: true",
    "runcmd:",
    // Password auth off, root login off. The Hetzner firewall is the outer
    // layer; this is the one that survives a firewall misconfiguration.
    "  - sed -i 's/^#\\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config",
    "  - sed -i 's/^#\\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config",
    "  - systemctl reload sshd",
    // Only 22, 80 and 443 are ever open. Application ports are never
    // published to the host, so there is nothing else to expose.
    "  - ufw default deny incoming",
    "  - ufw allow 22/tcp",
    "  - ufw allow 80/tcp",
    "  - ufw allow 443/tcp",
    "  - ufw --force enable",
    "  - mkdir -p /opt/platform/builds",
    // Unbounded container logs are the second most common way a deployment
    // host fills its disk, after images.
    "  - |",
    "    cat > /etc/docker/daemon.json <<EOF",
    "    { \"log-driver\": \"json-file\", \"log-opts\": { \"max-size\": \"10m\", \"max-file\": \"3\" } }",
    "    EOF",
    "  - systemctl restart docker"
  ].join("\n");
}

const provider = {
  name: "hetzner",

  isConfigured() {
    return !!(process.env.HETZNER_TOKEN || cfg.hetzner.token);
  },

  async createServer(opts) {
    const o = opts || {};
    const body = {
      name: o.name || "souqi-host-" + Date.now().toString(36),
      server_type: o.serverType || cfg.hetzner.serverType,
      image: o.image || cfg.hetzner.image,
      location: o.location || cfg.hetzner.location,
      start_after_create: true,
      user_data: userData(),
      labels: { platform: "souqi", role: "deploy-host" },
      public_net: { enable_ipv4: true, enable_ipv6: true }
    };
    const sshKeyId = o.sshKeyId || cfg.hetzner.sshKeyId;
    if (sshKeyId) body.ssh_keys = [Number(sshKeyId)];
    if (o.firewallId) body.firewalls = [{ firewall: Number(o.firewallId) }];

    const out = await api("POST", "/servers", body);
    return shape(out.server);
  },

  async deleteServer(id) {
    // Refuses to delete anything this platform did not create. An id typo
    // here would otherwise destroy a production server in the same project.
    const s = await api("GET", "/servers/" + encodeURIComponent(id));
    const labels = (s.server && s.server.labels) || {};
    if (labels.platform !== "souqi") {
      throw new Error("refusing to delete server " + id + ": it is not labelled platform=souqi");
    }
    await api("DELETE", "/servers/" + encodeURIComponent(id));
  },

  async getServer(id) {
    const out = await api("GET", "/servers/" + encodeURIComponent(id));
    return shape(out.server);
  },

  /**
   * Hetzner metrics are cloud-side and coarse. Real placement decisions use
   * the agent numbers from monitor/capacity.js on the host itself; this is
   * for the case where the host is unreachable and the scheduler still needs
   * to know whether it is alive.
   */
  async getServerResources(id) {
    const end = new Date();
    const start = new Date(end.getTime() - 5 * 60 * 1000);
    const qs = "?type=cpu&start=" + start.toISOString() + "&end=" + end.toISOString();
    const out = await api("GET", "/servers/" + encodeURIComponent(id) + "/metrics" + qs);
    const series = (out.metrics && out.metrics.time_series && out.metrics.time_series.cpu) || null;
    const values = (series && series.values) || [];
    const latest = values.length ? Number(values[values.length - 1][1]) : 0;
    return { cpuPct: Math.round(latest), memoryPct: null, diskPct: null, source: "hetzner-metrics" };
  },

  /**
   * The cloud-side firewall, which is a different layer from ufw on the box.
   *
   * ufw can be disabled by anything with root inside the VM; this one cannot
   * be reached from the VM at all. Belt and braces is the right posture when
   * the whole product is running other people code a few namespaces away.
   *
   * Idempotent: an existing firewall with this name is returned rather than
   * duplicated, so provisioning can be re-run safely.
   */
  async ensureFirewall(name) {
    const fwName = name || "souqi-deploy";
    const existing = await api("GET", "/firewalls?name=" + encodeURIComponent(fwName));
    if (existing.firewalls && existing.firewalls.length) {
      return { id: String(existing.firewalls[0].id), name: fwName, created: false };
    }

    // Only three ports, ever. Application ports are never published to the
    // host, so there is nothing else that could legitimately need to be open.
    const anywhere = ["0.0.0.0/0", "::/0"];
    const out = await api("POST", "/firewalls", {
      name: fwName,
      labels: { platform: "souqi" },
      rules: [
        { direction: "in", protocol: "tcp", port: "22",  source_ips: anywhere, description: "ssh" },
        { direction: "in", protocol: "tcp", port: "80",  source_ips: anywhere, description: "http (caddy)" },
        { direction: "in", protocol: "tcp", port: "443", source_ips: anywhere, description: "https (caddy)" },
        { direction: "in", protocol: "icmp", source_ips: anywhere, description: "ping" }
      ]
    });
    return { id: String(out.firewall.id), name: fwName, created: true };
  },

  /** Waits for a freshly created server to finish booting. */
  async waitForRunning(id, timeoutMs) {
    const deadline = Date.now() + (timeoutMs || 180000);
    while (Date.now() < deadline) {
      const s = await this.getServer(id);
      if (s.status === "running") return s;
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error("server " + id + " did not reach running state in time");
  },

  /** SSH keys already uploaded to the Hetzner project. */
  async listSshKeys() {
    const out = await api("GET", "/ssh_keys");
    return (out.ssh_keys || []).map((k) => ({ id: String(k.id), name: k.name, fingerprint: k.fingerprint }));
  },

  /** Server types, so provisioning can show real prices before spending. */
  async listServerTypes() {
    const out = await api("GET", "/server_types");
    return (out.server_types || []).map((t) => ({
      name: t.name, cores: t.cores, memoryGb: t.memory, diskGb: t.disk,
      priceMonthly: t.prices && t.prices[0] && t.prices[0].price_monthly
        ? Number(t.prices[0].price_monthly.gross).toFixed(2) : null
    }));
  },

  async listServers() {
    const out = await api("GET", "/servers?label_selector=platform%3Dsouqi");
    return (out.servers || []).map(shape);
  }
};

function shape(s) {
  if (!s) return null;
  return {
    id: String(s.id),
    name: s.name,
    publicIp: (s.public_net && s.public_net.ipv4 && s.public_net.ipv4.ip) || null,
    status: s.status || "unknown",
    cpuCores: (s.server_type && s.server_type.cores) || null,
    memoryMb: s.server_type ? Math.round(s.server_type.memory * 1024) : null,
    diskGb: (s.server_type && s.server_type.disk) || null
  };
}

module.exports = provider;
