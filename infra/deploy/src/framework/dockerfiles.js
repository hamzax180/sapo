/* =================================================================
   framework/dockerfiles.js — generate the build recipe
   -----------------------------------------------------------------
   This module is the answer to the spec rule "never allow user build
   scripts to execute directly on the host operating system". The
   platform never runs npm or pip. It writes a Dockerfile and hands it
   to docker build, so every user command runs inside a throwaway
   container, as an unprivileged user, with no access to the host or
   to the platform database.

   Every recipe is multi-stage. The build stage carries the toolchain
   and the source; the runtime stage carries only the artefact. That
   is a security property before it is a size one — the shipped image
   has no compiler, no package manager, and no source for an attacker
   to read.

   A user build command is written into the Dockerfile as-is. That is
   safe because it executes in the build container by design, but it
   also means such a command must never be interpolated anywhere that
   reaches a host shell.
   ================================================================= */
"use strict";

/** Refuses a command that could break out of the RUN line it sits on. */
function assertSafeCommand(cmd, label) {
  if (cmd == null) return null;
  const s = String(cmd);
  if (s.length > 500) throw new Error(label + " is too long");
  // A newline would let the value append its own Dockerfile instructions —
  // a COPY of the host filesystem, say, or a USER root. Everything else is
  // fine: it runs in the build container.
  if (/[\r\n]/.test(s)) throw new Error(label + " must be a single line");
  return s;
}

const NODE = "node:20-alpine";
const NGINX = "nginx:1.27-alpine";
/* Static sites are served by nginx as an unprivileged user, and a
   non-root process cannot bind a port below 1024 without
   CAP_NET_BIND_SERVICE — which user containers do not get. 8080 is the
   port nginx listens on, the port the image EXPOSEs, and the port the
   proxy must dial; detect.js pins the spec to it for the same reason. */
const STATIC_PORT = 8080;
const PYTHON = "python:3.12-slim";

/* ---------- static ----------
   Build with Node, ship with nginx. The runtime image is ~8MB and holds
   nothing but compiled assets — no source, no node_modules, no npm. */
function staticDockerfile(spec) {
  const build = assertSafeCommand(spec.buildCommand, "buildCommand");
  const out = (spec.outputDir || "dist").replace(/^\.?\//, "") || ".";

  const lines = [];
  if (build) {
    lines.push(
      "FROM " + NODE + " AS build",
      "WORKDIR /app",
      "COPY package*.json ./",
      "RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund",
      "COPY . .",
      "RUN " + build,
      ""
    );
  }
  /* Runs as the nginx user on 8080, not as root on 80.
     The stock image starts as root and hands its cache dirs to uid 101,
     which needs CAP_CHOWN — and user containers drop every capability. It
     also cannot bind 80 without CAP_NET_BIND_SERVICE. Both are the
     hardening working as intended, so the image gives way rather than the
     sandbox: unprivileged user, unprivileged port, and every path nginx
     writes moved under /tmp, which is the tmpfs the runtime already
     provides. Nothing here needs root, so nothing asks for it. */
  lines.push(
    "FROM " + NGINX,
    "RUN rm -f /etc/nginx/conf.d/default.conf",
    "COPY nginx.conf /etc/nginx/conf.d/app.conf",
    build ? "COPY --from=build /app/" + out + " /usr/share/nginx/html"
          : "COPY " + out + " /usr/share/nginx/html",
    // The pid and temp paths must be writable by uid 101 at runtime; /tmp
    // is a tmpfs, so they are created there by the config below.
    "RUN chown -R 101:101 /usr/share/nginx/html",
    // The pid path is main-context, so it cannot come from conf.d, and -g
    // would collide with the pid already in nginx.conf ("pid directive is
    // duplicate"). Rewriting the existing line is the one place it can be
    // changed without fighting the image.
    "RUN sed -i 's|^pid .*|pid /tmp/nginx.pid;|' /etc/nginx/nginx.conf",
    "USER 101",
    "EXPOSE " + STATIC_PORT,
    "CMD [\"nginx\", \"-g\", \"daemon off;\"]"
  );
  return lines.join("\n") + "\n";
}

/** The nginx server block shipped with every static app. */
function nginxConf() {
  return [
    // Everything nginx writes goes to /tmp: the runtime mounts it as a
    // tmpfs, and the defaults under /var/cache/nginx are unwritable on a
    // read-only root and unchownable without CAP_CHOWN. (The pid path is
    // main-context only, so it cannot be set here — it is passed with -g
    // on the command line instead.)
    "client_body_temp_path /tmp/client_temp;",
    "proxy_temp_path /tmp/proxy_temp;",
    "fastcgi_temp_path /tmp/fastcgi_temp;",
    "uwsgi_temp_path /tmp/uwsgi_temp;",
    "scgi_temp_path /tmp/scgi_temp;",
    "",
    "server {",
    "  listen " + STATIC_PORT + ";",
    "  server_name _;",
    "  root /usr/share/nginx/html;",
    "  index index.html;",
    "  # Content-hashed assets are immutable; everything else revalidates so",
    "  # a redeploy is visible immediately.",
    "  location ~* \.(js|css|woff2?|png|jpg|jpeg|svg|webp|ico)$ {",
    "    expires 1y;",
    "    add_header Cache-Control \"public, immutable\";",
    "  }",
    "  location / {",
    "    add_header Cache-Control \"no-cache\";",
    "    try_files $uri $uri/ /index.html;",
    "  }",
    "}"
  ].join("\n") + "\n";
}

/* ---------- node ---------- */
function nodeDockerfile(spec) {
  const build = assertSafeCommand(spec.buildCommand, "buildCommand");
  const start = assertSafeCommand(spec.startCommand, "startCommand") || "node index.js";
  const port = Number(spec.port) || 3000;

  const lines = [
    "FROM " + NODE + " AS build",
    "WORKDIR /app",
    "COPY package*.json ./",
    "RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund",
    "COPY . ."
  ];
  if (build) lines.push("RUN " + build);
  lines.push(
    "RUN npm prune --omit=dev || true",
    "",
    "FROM " + NODE,
    "WORKDIR /app",
    "ENV NODE_ENV=production",
    "COPY --from=build /app ./",
    "USER node",
    "EXPOSE " + port,
    "CMD " + shellForm(start)
  );
  return lines.join("\n") + "\n";
}

/* ---------- next.js ----------
   Next needs its own server. A static export is a different product, and
   switching to one silently would break API routes and SSR. */
function nextDockerfile(spec) {
  const build = assertSafeCommand(spec.buildCommand, "buildCommand") || "npm run build";
  const start = assertSafeCommand(spec.startCommand, "startCommand") || "npm start";
  const port = Number(spec.port) || 3000;
  return [
    "FROM " + NODE + " AS build",
    "WORKDIR /app",
    "COPY package*.json ./",
    "RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund",
    "COPY . .",
    "ENV NEXT_TELEMETRY_DISABLED=1",
    "RUN " + build,
    "",
    "FROM " + NODE,
    "WORKDIR /app",
    "ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1",
    "COPY --from=build /app ./",
    "USER node",
    "EXPOSE " + port,
    "CMD " + shellForm(start)
  ].join("\n") + "\n";
}

/* ---------- python ---------- */
function pythonDockerfile(spec) {
  const start = assertSafeCommand(spec.startCommand, "startCommand") || "python main.py";
  const port = Number(spec.port) || 8000;
  return [
    "FROM " + PYTHON + " AS build",
    "WORKDIR /app",
    /* Three things this has to survive, all of which broke the old
       two-liner:

       - No requirements.txt at all. detect.js accepts a project with only
         pyproject.toml, and `COPY requirements*.txt ./` fails outright
         when the glob matches nothing.
       - An app with no dependencies. `pip install --user` only creates
         /root/.local when it installs something, so the runtime stage's
         COPY --from=build /root/.local failed on every dependency-free
         app. mkdir makes the directory unconditional.
       - A genuinely broken requirements.txt. The old `|| true` swallowed
         the pip error and let the build continue, so the failure surfaced
         later as a mystery COPY error, or worse as a container that
         crash-looped on ImportError. Now pip's own message is the error. */
    "COPY . .",
    "RUN mkdir -p /root/.local \\",
    " && if [ -f requirements.txt ]; then pip install --no-cache-dir --user -r requirements.txt; fi",
    "",
    "FROM " + PYTHON,
    "WORKDIR /app",
    "ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 PATH=/home/app/.local/bin:$PATH",
    "RUN useradd --create-home --uid 1000 app",
    "COPY --from=build /root/.local /home/app/.local",
    "COPY . .",
    "RUN chown -R app:app /app /home/app/.local",
    "USER app",
    "EXPOSE " + port,
    "CMD " + shellForm(start)
  ].join("\n") + "\n";
}

/** Shell form so a user command can use pipes and env expansion. */
function shellForm(cmd) {
  return "[\"sh\", \"-c\", " + JSON.stringify(cmd) + "]";
}

/**
 * @returns {{dockerfile: string, extraFiles: Object<string,string>}}
 */
function generate(spec) {
  switch (spec.framework) {
    case "static":  return { dockerfile: staticDockerfile(spec), extraFiles: { "nginx.conf": nginxConf() } };
    case "node":    return { dockerfile: nodeDockerfile(spec), extraFiles: {} };
    case "nextjs":  return { dockerfile: nextDockerfile(spec), extraFiles: {} };
    case "python":  return { dockerfile: pythonDockerfile(spec), extraFiles: {} };
    default: throw new Error("unsupported framework: " + spec.framework);
  }
}

/** Never ship these into a build context, whatever was uploaded. */
function dockerignore() {
  return [
    ".git", "node_modules", ".env", ".env.*", "*.log",
    "Dockerfile", ".dockerignore", ".DS_Store", "dist", "build", ".next"
  ].join("\n") + "\n";
}

module.exports = { generate, dockerignore, assertSafeCommand };
