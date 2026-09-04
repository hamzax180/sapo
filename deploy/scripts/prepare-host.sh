#!/usr/bin/env bash
# =================================================================
#  prepare-host.sh — bring a bare Ubuntu VPS up to the state
#  provision.js leaves a Hetzner host in.
#  -----------------------------------------------------------------
#  provision.js does two jobs: it creates a Hetzner server, and it
#  hands that server a cloud-init that hardens it. On any other
#  provider — OVH, netcup, a box someone already had — the first job
#  is done in a web console and the second one does not happen at
#  all. This is that second job, and only that job. It creates
#  nothing and it costs nothing.
#
#    bash scripts/prepare-host.sh 203.0.113.10
#    bash scripts/prepare-host.sh 203.0.113.10 --check   # report only
#    SSH_USER=ubuntu bash scripts/prepare-host.sh 203.0.113.10
#
#  Then continue with the documented flow, unchanged:
#
#    bash scripts/ship.sh 203.0.113.10
#
#  Idempotent, like ship.sh. Every step checks for its own result
#  first, so a re-run after a half-finished attempt is the intended
#  way to use it rather than something to be careful about.
#
#  One difference from the Hetzner path worth knowing: Hetzner's
#  docker-ce image ships Docker already installed, so cloud-init only
#  has to harden. Here we install it too, from Docker's own apt
#  repository — signed packages from a pinned source, rather than
#  piping a script from the internet into a root shell.
# =================================================================
set -euo pipefail

HOST="${1:-}"
MODE="${2:-}"
SSH_USER="${SSH_USER:-root}"

if [ -z "$HOST" ]; then
  echo "usage: bash scripts/prepare-host.sh <server-ip> [--check]"
  echo "       SSH_USER=ubuntu bash scripts/prepare-host.sh <server-ip>"
  exit 1
fi

say()  { printf "\n\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\n\033[31m%s\033[0m\n\n" "$*"; exit 1; }

SSH="ssh -o StrictHostKeyChecking=accept-new ${SSH_USER}@${HOST}"

say "Connecting to ${SSH_USER}@${HOST}"
$SSH "true" || fail "cannot ssh to ${SSH_USER}@${HOST}. Check the IP and that your key is on the box."
OS="$($SSH '. /etc/os-release && echo "$NAME $VERSION_ID ($VERSION_CODENAME)"')"
echo "  $OS"

# Everything below needs root. Running as a non-root user is normal on
# OVH and several other providers, so escalate rather than refusing —
# but fail early and clearly if sudo is not going to work, instead of
# part-way through the hardening.
if [ "$SSH_USER" = "root" ]; then
  SUDO=""
else
  $SSH "sudo -n true 2>/dev/null" \
    || fail "${SSH_USER} needs passwordless sudo on the host (or run with SSH_USER=root)."
  SUDO="sudo"
  echo "  using sudo as ${SSH_USER}"
fi

# -----------------------------------------------------------------
#  The one step here that can lock you out of your own server.
#
#  Hardening turns password authentication off. On Hetzner that is
#  safe by construction: provision.js creates the server WITH an ssh
#  key and there was never a password to begin with. Other providers
#  hand you a password instead — OVH mails you one and tells you to
#  set it in their manager — and on those, running this before your
#  key is installed disables the only credential you have.
#
#  So: prove key auth will still work before removing the alternative.
#  A non-empty authorized_keys for the account we are connecting as is
#  that proof. Checked here, before anything at all has been modified,
#  rather than inside the remote script halfway through.
# -----------------------------------------------------------------
if ! $SSH "test -s ~/.ssh/authorized_keys" 2>/dev/null; then
  fail "$(cat <<EOF
${SSH_USER}@${HOST} has no ssh key installed (~/.ssh/authorized_keys is empty
or missing), and this script disables password authentication. Running it now
would leave you unable to log in at all.

Install your key first, from your laptop:

    ssh-copy-id ${SSH_USER}@${HOST}

If you have no key yet:

    ssh-keygen -t ed25519
    ssh-copy-id ${SSH_USER}@${HOST}

Confirm it works WITHOUT a password prompt, then re-run this script:

    ssh -o PasswordAuthentication=no ${SSH_USER}@${HOST} true
EOF
)"
fi
echo "  ssh key present — safe to disable password auth"

# -----------------------------------------------------------------
#  --check: say what is and is not done, change nothing.
# -----------------------------------------------------------------
if [ "$MODE" = "--check" ]; then
  say "Reporting only — nothing will be changed"
  $SSH "$SUDO bash -s" <<'REMOTE'
set -u
ok()   { printf "  \033[32m✓\033[0m %s\n" "$*"; }
no()   { printf "  \033[31m✗\033[0m %s\n" "$*"; }
command -v docker >/dev/null 2>&1 && ok "docker installed ($(docker --version 2>/dev/null))" || no "docker not installed"
docker compose version >/dev/null 2>&1 && ok "compose plugin present" || no "compose plugin missing"
# ship.sh drives docker over ssh as the login user with no sudo, so this
# is a requirement and not a convenience. Skipped for root, which needs
# no group to reach the socket.
if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  id -nG "$SUDO_USER" 2>/dev/null | tr ' ' '\n' | grep -qx docker \
    && ok "${SUDO_USER} can reach the docker socket" || no "${SUDO_USER} not in the docker group"
fi
grep -q '"default-address-pools"' /etc/docker/daemon.json 2>/dev/null \
  && ok "docker daemon.json has address pools + log rotation" || no "docker daemon.json not configured"
ufw status 2>/dev/null | grep -q "Status: active" && ok "ufw active" || no "ufw not active"
grep -qE '^PasswordAuthentication\s+no' /etc/ssh/sshd_config 2>/dev/null \
  && ok "ssh password auth off" || no "ssh password auth still on"
[ -d /opt/platform/builds ] && ok "/opt/platform/builds exists" || no "/opt/platform/builds missing"
# ship.sh mkdirs and writes under /opt/platform as the login user.
if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  [ "$(stat -c %U /opt/platform 2>/dev/null)" = "$SUDO_USER" ] \
    && ok "/opt/platform writable by ${SUDO_USER}" || no "/opt/platform not owned by ${SUDO_USER}"
fi
REMOTE
  echo ""
  exit 0
fi

# -----------------------------------------------------------------
#  The real run. One remote script, quoted heredoc — nothing from
#  this laptop is interpolated into it, so there is no quoting seam
#  where a local variable could end up being evaluated by a root
#  shell on the server.
# -----------------------------------------------------------------
say "Preparing the host"
$SSH "$SUDO bash -s" <<'REMOTE'
set -euo pipefail
step() { printf "\n  \033[1m%s\033[0m\n" "$*"; }

export DEBIAN_FRONTEND=noninteractive

step "Packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg ufw >/dev/null
echo "    base packages ok"

# ---- Docker, from Docker's own repository ----------------------
# Hetzner's docker-ce image has this already; a stock Ubuntu image
# does not. Ubuntu's own docker.io package lags badly and does not
# ship the compose plugin, which ship.sh requires.
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  echo "    docker already installed — $(docker --version)"
else
  step "Docker"
  install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.asc ]; then
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
  fi

  ARCH="$(dpkg --print-architecture)"
  CODENAME="$(. /etc/os-release && echo "${VERSION_CODENAME:-}")"

  # A very fresh Ubuntu release can exist months before Docker
  # publishes a suite for it, and the failure mode is an apt update
  # that 404s halfway through. Check first, and fall back to the
  # newest suite Docker actually serves — saying so out loud, because
  # silently installing packages built for a different release is
  # exactly the kind of thing that should not happen quietly.
  if curl -fsI "https://download.docker.com/linux/ubuntu/dists/${CODENAME}/Release" >/dev/null 2>&1; then
    SUITE="$CODENAME"
  else
    for c in noble jammy; do
      if curl -fsI "https://download.docker.com/linux/ubuntu/dists/${c}/Release" >/dev/null 2>&1; then
        SUITE="$c"; break
      fi
    done
    echo "    NOTE: Docker has no repository for '${CODENAME}' yet — using '${SUITE}' packages."
  fi

  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${SUITE} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
                         docker-buildx-plugin docker-compose-plugin >/dev/null
  echo "    installed $(docker --version)"
fi

# ---- socket access for a non-root login -------------------------
# On Hetzner you connect as root and this never comes up. Everywhere
# that hands you a normal account instead, it does — and not just
# here: ship.sh runs `docker compose up -d --build` over ssh as the
# login user with no sudo, so without this the ship fails at the one
# step that matters, after having already copied the stack up.
#
# The docker group is root-equivalent — anyone in it can start a
# container that mounts the host filesystem. That is worth saying out
# loud, and here it grants nothing new: this script already required
# passwordless sudo to run at all, so the account is root-equivalent
# before we touch it. Adding root to the group would be meaningless,
# so this is skipped entirely when there is no sudo user.
if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  step "Docker socket access"
  if id -nG "$SUDO_USER" | tr ' ' '\n' | grep -qx docker; then
    echo "    ${SUDO_USER} already in the docker group"
  else
    usermod -aG docker "$SUDO_USER"
    # Group membership is resolved at login, so the session running
    # this script still cannot use the socket. The next ssh connection
    # can, which is why the verification below reconnects rather than
    # testing from in here.
    echo "    added ${SUDO_USER} to the docker group (applies to new sessions)"
  fi
fi

# ---- Docker daemon config --------------------------------------
# Identical to the cloud-init in src/providers/hetzner.js, and for
# the same two reasons:
#
#   log-opts: unbounded container logs are the second most common way
#   a deployment host fills its disk, after images. On a 75GB box that
#   is a matter of weeks, not months.
#
#   default-address-pools: every deployment gets its OWN docker
#   network so no two user containers can reach each other. Docker's
#   built-in pools yield roughly 31 networks total, which
#   MAX_CONTAINERS=40 would exhaust — and once exhausted, network
#   creation fails and every further deploy fails with it.
#   10.200.0.0/16 carved into /24s gives 256.
step "Docker daemon config"
if [ -f /etc/docker/daemon.json ] && grep -q '"default-address-pools"' /etc/docker/daemon.json; then
  echo "    already configured"
else
  # Never clobber an existing config unseen — keep a copy first.
  [ -f /etc/docker/daemon.json ] && cp /etc/docker/daemon.json /etc/docker/daemon.json.bak
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" },
  "default-address-pools": [ { "base": "10.200.0.0/16", "size": 24 } ]
}
EOF
  systemctl restart docker
  echo "    written, docker restarted"
fi

# ---- SSH -------------------------------------------------------
# Password auth off, root login key-only. On Hetzner the cloud
# firewall is the outer layer and this is the one that survives a
# firewall misconfiguration; on a provider with no cloud firewall
# in front, this IS the layer.
step "SSH"
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
# Newer Ubuntu images ship drop-ins under sshd_config.d that are read
# AFTER the main file and would re-enable password auth behind our
# back. Cloud images very commonly carry exactly such a file.
if [ -d /etc/ssh/sshd_config.d ]; then
  for f in /etc/ssh/sshd_config.d/*.conf; do
    [ -e "$f" ] || continue
    sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "$f"
  done
fi
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true
echo "    password auth off, root login key-only"

# ---- Firewall --------------------------------------------------
# Only 22, 80 and 443 are ever open. Application ports are never
# published to the host — Caddy is the only service in the compose
# file with a ports: line — so there is nothing else to expose.
#
# ufw is enabled with --force because this runs non-interactively;
# the allow for 22 is deliberately BEFORE the enable, or the run
# would cut off the ssh session executing it.
step "Firewall"
ufw allow 22/tcp   >/dev/null
ufw allow 80/tcp   >/dev/null
ufw allow 443/tcp  >/dev/null
ufw default deny incoming >/dev/null
ufw --force enable >/dev/null
echo "    inbound 22, 80, 443 — everything else denied"

step "Build directory"
mkdir -p /opt/platform/builds
echo "    /opt/platform/builds"

# ---- ownership for a non-root login -----------------------------
# Second half of the same problem the docker group solved above.
# ship.sh runs `mkdir -p /opt/platform/stack` and rsyncs the stack in
# over ssh as the login user, with no sudo — so on Hetzner, where you
# connect as root, /opt/platform being root-owned is invisible. As a
# normal user it fails on the very first remote command, after the
# local preflight and all 71 verify checks have already passed, which
# makes it look like a problem with the stack rather than a
# permission on one directory.
#
# Handing the deploy user the tree is the honest fix: it owns what it
# ships. Nothing sensitive lives here — .env arrives later as mode
# 600, and the containers use named volumes, not this path.
if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  chown -R "${SUDO_USER}:${SUDO_USER}" /opt/platform
  echo "    owned by ${SUDO_USER} (ship.sh writes here without sudo)"
fi
REMOTE

# -----------------------------------------------------------------
#  Verify from outside, the way ship.sh does. A step that reported
#  success on the way past is not the same as a host that is ready.
# -----------------------------------------------------------------
say "Verifying"
$SSH "command -v docker >/dev/null"          || fail "docker is still not on the host"
$SSH "docker compose version >/dev/null 2>&1" || fail "compose plugin is still missing"
# Deliberately WITHOUT sudo, and deliberately over a fresh connection.
# This is the exact thing ship.sh does, as the same user, so testing it
# as root would prove nothing about whether the ship will work.
$SSH "docker run --rm hello-world >/dev/null 2>&1" \
  || fail "docker cannot run a container as ${SSH_USER}.
If 'sudo docker run' works but this does not, ${SSH_USER} is not in the docker
group yet — re-run this script, which adds it. Otherwise check the daemon:
  ssh ${SSH_USER}@${HOST} 'sudo systemctl status docker'"
echo "  docker runs containers as ${SSH_USER}"
$SSH "$SUDO ufw status | grep -q 'Status: active'" || fail "ufw did not come up"
echo "  ufw active"
$SSH "$SUDO grep -q '\"default-address-pools\"' /etc/docker/daemon.json" \
  || fail "daemon.json is missing the address pools"
echo "  daemon.json configured"
$SSH "test -d /opt/platform/builds" || fail "/opt/platform/builds was not created"
echo "  build directory present"

say "Done"
cat <<EOF

  ${HOST} is ready — same state provision.js leaves a Hetzner host in.

  Next, in order:

    1. Point DNS at it, and give it a minute to propagate:
         *.yourdomain.com   A   ${HOST}

    2. Set APP_DOMAIN and ACME_EMAIL in .env to match, then:
         node scripts/preflight.js --generate
         node scripts/preflight.js

    3. Ship the stack:
         bash scripts/ship.sh ${HOST}

  Re-check this host at any time without changing it:
    bash scripts/prepare-host.sh ${HOST} --check

EOF
