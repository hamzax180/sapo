"""Build the Souqi architecture + activity reference PDF."""
import sys
from reportlab.pdfgen import canvas
from reportlab.lib.units import mm
from reportlab.lib import colors
from souqi_diagrams import *      # helpers, palette, page geometry
import souqi_diagrams as D

OUT = sys.argv[1] if len(sys.argv) > 1 else "souqi-architecture.pdf"
TOTAL = 9
L, R = 28 * mm, W - 28 * mm          # content left / right
CW = R - L

c = canvas.Canvas(OUT, pagesize=PAGE)
c.setTitle("Souqi - Architecture and Activity Reference")
c.setAuthor("Souqi")
c.setSubject("Traced from the repository: request path, agent loop, deployment pipeline")


# ==========================================================  1  cover
c.setFillColor(PAPER); c.rect(0, 0, W, H, stroke=0, fill=1)
c.setFillColor(PLATFORM); c.rect(0, H - 8, W, 8, stroke=0, fill=1)
c.setFillColor(PLANE);    c.rect(W * 0.62, H - 8, W * 0.38, 8, stroke=0, fill=1)

c.setFillColor(MUT); c.setFont(F, 10); c.drawString(L, H - 92, "SOUQI")
c.setFillColor(INK); c.setFont(FB, 40)
c.drawString(L, H - 146, "Architecture and Activity Reference")
c.setFillColor(INK2); c.setFont(F, 13)
c.drawString(L, H - 176, "From a typed sentence to a running container - every hop, with the technology on each one.")
c.setStrokeColor(LINE); c.setLineWidth(0.8); c.line(L, H - 196, R, H - 196)

col = CW / 3.0 - 16
y0 = H - 232
for i, (head, body) in enumerate([
    ("WHAT IT IS",
     "An AI app builder. Someone describes an app; a model writes React and TypeScript; the "
     "browser compiles it; the result is published as a static site or shipped as a Docker "
     "container with its own domain, TLS and database."),
    ("TWO INDEPENDENT SYSTEMS",
     "A Vercel deployment serving the pages and one serverless function, and a VPS running a "
     "Docker stack. They share a git repository and nothing else - they talk over HTTP, and "
     "neither imports a line of the other's code."),
    ("HOW TO READ THIS",
     "Pages 3 to 6 are UML activity diagrams with swimlanes: a column per participant, time "
     "running down the page. Dashed arrows cross a trust or machine boundary. Every route "
     "name, timeout and image tag is quoted from the source."),
]):
    x = L + i * (col + 24)
    c.setFillColor(PLATFORM if i == 0 else (PLANE if i == 1 else MUT))
    c.setFont(FB, 7.6); c.drawString(x, y0, head)
    c.setFillColor(INK2); c.setFont(F, 9)
    yy = y0 - 16
    for ln in wrap(body, F, 9, col):
        c.drawString(x, yy, ln); yy -= 12.4

# the numbers
c.setStrokeColor(LINE); c.line(L, H - 350, R, H - 350)
c.setFillColor(MUT); c.setFont(FB, 7.6); c.drawString(L, H - 368, "THE SHAPE OF IT")
stats = [("131", "HTTP routes"), ("99", "under /api"), ("3", "path prefixes reach Express"),
         ("16", "static pages"), ("4", "effort levels"), ("300s", "function ceiling"),
         ("4", "framework families the plane builds"), ("3", "Docker networks")]
sx = L
for v, k in stats:
    c.setFillColor(INK); c.setFont(FB, 21); c.drawString(sx, H - 404, v)
    c.setFillColor(MUT); c.setFont(F, 7.8)
    for j, ln in enumerate(wrap(k, F, 7.8, 118)):
        c.drawString(sx, H - 418 - j * 9.6, ln)
    sx += CW / len(stats)

# legend
c.setStrokeColor(LINE); c.line(L, H - 452, R, H - 452)
c.setFillColor(MUT); c.setFont(FB, 7.6); c.drawString(L, H - 470, "ACTIVITY DIAGRAM NOTATION")
lx = L
for kind, lab in [("start", "start"), ("action", "action"), ("decision", "decision"),
                  ("bar", "fork / join"), ("end", "end")]:
    legend_chip(c, lx, H - 500, kind, lab)
    lx += 150
c.setFillColor(INK2); c.setFont(F, 8.4)
c.drawString(lx, H - 503, "Dashed arrow = crosses a machine or trust boundary.")

note(c, L, H - 546, CW * 0.47,
     "the one that catches people",
     "In production only /api/*, /auth/* and /s/* reach Express. Everything else is a static "
     "file, or a 404 at the edge before the function is invoked. So backend/index.js contains "
     "routes that cannot run on souqi.site - a 404 from production means \"not routed here\", "
     "not \"refused\".", PLATFORM)
note(c, L + CW * 0.53, H - 546, CW * 0.47,
     "the other one",
     "git push deploys nothing. Vercel is shipped from the CLI and the container plane from "
     "ship.sh. A push updates GitHub and leaves both running systems exactly as they were - "
     "which is why a deploy is verified against a marker that exists only in the new code.",
     PLANE)

c.setFillColor(MUT); c.setFont(F, 7.6)
c.drawString(L, 12 * mm, "Souqi  ·  architecture and activity reference  ·  traced from the repository")
c.drawRightString(R, 12 * mm, "1 / %d" % TOTAL)
c.showPage()


# ==========================================================  2  architecture
page_frame(c, "Deployment architecture", "What runs where, and on what.", 2, TOTAL)
top = H - 120

# --- browser
action(c, L + 95, top - 90, 176, 96, "Browser", "Chromium / Firefox / Safari", stroke=BROWSER, bold=True)
tech(c, L + 95, top - 152, 176, 34, "WebContainer (@webcontainer/api 1.x, jsDelivr) - npm install, tsc --noEmit, vite build")
tech(c, L + 95, top - 196, 176, 30, "Vanilla JS, no build step. Jost + Inter via Google Fonts")

# --- vercel
vx0, vw = L + 235, 420
c.setStrokeColor(PLATFORM); c.setLineWidth(1.4); c.setFillColor(colors.white)
c.roundRect(vx0, top - 300, vw, 296, 7, stroke=1, fill=0)
c.setFillColor(PLATFORM); c.setFont(FB, 8)
c.drawString(vx0 + 14, top - 22, "VERCEL  ·  project sapone  ·  souqi.site")

action(c, vx0 + vw / 2, top - 62, vw - 44, 42, "frontend/  -  16 static pages, served as-is",
       "cleanUrls: login.html is served at /login   ·   outputDirectory: frontend")
action(c, vx0 + vw / 2, top - 128, vw - 44, 56, "api/index.js  ->  backend/  (one serverless function)",
       "Node 20+ · Express 4.19 · maxDuration 300s · memory 1024 MB", stroke=PLATFORM, bold=True)
action(c, vx0 + vw / 2, top - 196, vw - 44, 44, "backend/lib/codeagent  -  the agent",
       "model loop, tool schema, scaffold blob, context budget")
action(c, vx0 + vw / 2, top - 258, vw - 44, 44, "backend/lib/ai  -  one adapter, three routes",
       "json · prose · vision   all pointed at DeepSeek")

# --- plane
px0, pw = vx0 + vw + 46, R - (vx0 + vw + 46)
c.setStrokeColor(PLANE); c.setLineWidth(1.4)
c.roundRect(px0, top - 300, pw, 296, 7, stroke=1, fill=0)
c.setFillColor(PLANE); c.setFont(FB, 8)
c.drawString(px0 + 14, top - 22, "VPS  ·  THE DEPLOY PLANE  ·  148.113.174.192")

action(c, px0 + pw / 2, top - 58, pw - 40, 36, "caddy 2-alpine", "the only published ports: 80, 443", stroke=PLANE)
action(c, px0 + pw * 0.27, top - 116, pw * 0.44, 38, "api", "control plane")
action(c, px0 + pw * 0.73, top - 116, pw * 0.44, 38, "worker", "the only docker socket", stroke=PLANE)
action(c, px0 + pw * 0.27, top - 174, pw * 0.44, 36, "postgres 16", "platform data")
action(c, px0 + pw * 0.73, top - 174, pw * 0.44, 36, "userdb 16", "customer data")
action(c, px0 + pw / 2, top - 244, pw - 40, 50, "one container per deployed app",
       "node:20-alpine  ·  nginx:1.27-alpine  ·  python:3.12-slim")

# --- edges
arrow(c, L + 185, top - 62, vx0 - 4, top - 62, "everything else", color=INK)
arrow(c, L + 185, top - 118, vx0 - 4, top - 118, "/api  /auth  /s", color=PLATFORM, lw=1.5)
arrow(c, vx0 + vw + 4, top - 128, px0 - 4, top - 128, "HTTPS", color=PLANE, dashed=True, lw=1.4)
c.setFillColor(PLANE); c.setFont(F, 7)
c.drawCentredString((vx0 + vw + px0) / 2, top - 146, "x-platform-token")
c.drawCentredString((vx0 + vw + px0) / 2, top - 156, "+ sq_session")

# --- external services
c.setStrokeColor(LINE); c.setLineWidth(0.8); c.line(L, top - 328, R, top - 328)
c.setFillColor(MUT); c.setFont(FB, 7.6); c.drawString(L, top - 346, "EXTERNAL SERVICES")
ex = [("MongoDB Atlas", "projects, revisions, users, sessions, usage, audit", "mongodb 6.8"),
      ("DeepSeek", "every model route; per-route breaker, spend line and budget", "OpenAI-compatible HTTP"),
      ("S3 / R2", "uploaded images and deployment source archives", "hand-rolled SigV4"),
      ("Stripe", "checkout and the webhook that grants a plan", "js.stripe.com/v3"),
      ("Hetzner Cloud", "provisioning a host for the plane", "REST, provider interface")]
exw = CW / len(ex)
for i, (nm, what, how) in enumerate(ex):
    x = L + i * exw
    c.setFillColor(INK); c.setFont(FB, 9.6); c.drawString(x, top - 372, nm)
    c.setFillColor(INK2); c.setFont(F, 8.2)
    yy = top - 386
    for ln in wrap(what, F, 8.2, exw - 18):
        c.drawString(x, yy, ln); yy -= 10.4
    c.setFillColor(MUT); c.setFont(FO, 7.6)
    for ln in wrap(how, FO, 7.6, exw - 18):
        c.drawString(x, yy - 2, ln); yy -= 9.6

note(c, L, top - 452, CW * 0.47, "why api/ cannot move",
     "Vercel discovers serverless functions only at <root>/api/, and vercel.json names "
     "api/index.js by path. It is a one-line shim so the same Express app runs as a function "
     "in production and as a plain server locally - backend/index.js exports the app when "
     "process.env.VERCEL is set and calls listen() when it is not.", PLATFORM)
note(c, L + CW * 0.53, top - 452, CW * 0.47, "why the scaffold ships as JSON",
     "Included as a directory, Vercel's bundler transpiles the TypeScript it finds - App.tsx "
     "becomes App.js - while index.html still asks for main.tsx, and the deployed app dies "
     "with an empty dist. Excluded without the blob, Rollup cannot resolve /src/main.tsx. A "
     ".json is neither compiled nor dropped, so scaffold-data.json is what ships.", PLANE)
c.showPage()


# ==========================================================  3  activity: request -> first build
page_frame(c, "Activity  -  a message becomes a built app",
           "One POST, one long-lived SSE response. The compile happens on the visitor's machine.", 3, TOTAL)
LY0, LH = 150, 565
cxs, lw = lanes(c, L, LY0, CW, LH, ["Browser", "Vercel function", "DeepSeek"],
                [BROWSER, PLATFORM, MODEL])
B, V, M = cxs
aw = 224
rows = [646, 580, 514, 448, 382, 316, 250, 184]

start_node(c, B, rows[0] + 44)
arrow(c, B, rows[0] + 37, B, rows[0] + 24)
action(c, B, rows[0], aw, 40, "Type a brief, pick effort and mode",
       "fast / balanced / smart / max")
arrow(c, B + aw / 2, rows[0] - 8, V - aw / 2, rows[1] + 8,
      "POST /build  ·  SSE", color=PLATFORM, dashed=True, lw=1.4)

action(c, V, rows[1], aw, 42, "Resolve the owner, THEN open the stream",
       "the cookie needs setHeader; the stream commits them", stroke=PLATFORM)
arrow(c, V, rows[1] - 21, V, rows[2] + 21)
action(c, V, rows[2], aw, 44, "Six gates, cheapest first",
       "length · ownership · small talk · free edits · allowance")
arrow(c, V, rows[2] - 22, V, rows[3] + 21)
action(c, V, rows[3], aw, 42, "Rebuild the codebase from its revisions",
       "materialize() - a follow-up only")
arrow(c, V, rows[3] - 21, V, rows[4] + 22)
action(c, V, rows[4], aw, 44, "Fit the request inside the model's window",
       "window - (reply x 2) - prompt - tools - history - errors")
arrow(c, V + aw / 2, rows[4] - 8, M - aw / 2, rows[5] + 8,
      "json route", color=MODEL, dashed=True, lw=1.4)

action(c, M, rows[5], aw, 46, "Generate, and call tools",
       "write_file · edit_file · read_file · list_files", stroke=MODEL)
arrow(c, M - aw / 2, rows[5] - 8, V + aw / 2, rows[6] + 8,
      "the files", color=MODEL, dashed=True, lw=1.4)

action(c, V, rows[6], aw, 50, "Merge scaffold and theme, mint a buildId, PARK A PROMISE",
       "payments.ts · tailwind.config.js · font marker", stroke=PLATFORM, bold=True)
arrow(c, V - aw / 2, rows[6] - 8, B + aw / 2, rows[7] + 8,
      "event: files", color=PLATFORM, dashed=True, lw=1.6)

action(c, B, rows[7], aw, 52, "WebContainer builds it, then reports back",
       "npm install · tsc --noEmit · vite build")
elbow(c, [(B + aw / 2, rows[7]), (V - aw / 2 - 24, rows[7]), (V - aw / 2 - 24, rows[7] - 26),
          (V - 4, rows[7] - 26)], "POST /build-feedback resolves the promise",
      color=PLATFORM, dashed=True, lw=1.6)
c.setFillColor(INK); c.setFont(FB, 9)
c.drawCentredString(V + 44, rows[7] - 44, "continued on page 4  -  the repair loop")

note(c, L, 126, CW * 0.47, "the compile is not on the server",
     "The server writes code, emits it, and blocks on a promise keyed by a random buildId "
     "until a completely separate HTTP request resolves it. tsc --noEmit runs because Vite's "
     "build is esbuild, which strips TypeScript types without checking them - without it a "
     "genuinely broken app compiles clean and the repair loop never learns there was anything "
     "to fix.", PLATFORM)
note(c, L + CW * 0.53, 126, CW * 0.47, "when the browser cannot build",
     "Every phone, and any browser without SharedArrayBuffer, sends canBuild:false. That skips "
     "the client-build loop entirely - one model call, files returned directly, and "
     "verified:false on the result, so the audit does not record an unverified build as a "
     "success.", MUT)
c.showPage()


# ==========================================================  4  activity: the repair loop
page_frame(c, "Activity  -  the repair loop and its two budgets",
           "A round is bounded by the effort level AND by the wall clock the platform enforces.", 4, TOTAL)
SP, R2, R3 = 620, 500, 380          # the three rows

start_node(c, 150, SP)
arrow(c, 157, SP, 178, SP)
action(c, 270, SP, 176, 44, "Round 0", "always runs - without it there is nothing to hand back", bold=True)
arrow(c, 358, SP, 403, SP)
action(c, 500, SP, 190, 46, "Build in the browser", "wait = min(180s, time left - 15s)")
arrow(c, 595, SP, 648, SP)
decision(c, 740, SP, 184, 58, "did it compile?")
arrow(c, 832, SP, 856, SP, "yes", color=OK, lw=1.3)
action(c, 960, SP, 200, 48, "Persist a revision, emit result", "ok:true, verified, cost, rounds", stroke=OK)
arrow(c, 1060, SP, 1082, SP)
end_node(c, 1090, SP)

arrow(c, 740, SP - 29, 740, R2 + 29, "no")
decision(c, 740, R2, 210, 58, "rounds left at this effort?")
arrow(c, 635, R2, 545, R2, "no", color=BAD, lw=1.2)
action(c, 440, R2, 196, 48, "Ship a starter template", "with the real reason attached", stroke=BAD)
arrow(c, 342, R2, 268, R2, color=BAD)
end_node(c, 258, R2)

arrow(c, 740, R2 - 29, 740, R3 + 31, "yes")
decision(c, 740, R3, 232, 62, "time left for a whole round?")
c.setFillColor(MUT); c.setFont(FO, 7.6)
c.drawCentredString(740, R3 - 46, "the estimate is the slowest round measured so far, not a constant")
arrow(c, 856, R3, 878, R3, "no", color=PLANE, lw=1.3)
action(c, 985, R3, 210, 52, "Hand back the tree as it stands",
       "ok:true, verified:false, ranOutOfTime", stroke=PLANE, bold=True)
arrow(c, 985, R3 - 26, 985, R3 - 56)
end_node(c, 985, R3 - 66)

elbow(c, [(624, R3), (150, R3), (150, 690), (500, 690), (500, SP + 23)],
      "yes  -  the next round", color=INK)

c.setStrokeColor(LINE); c.setLineWidth(0.8); c.line(L, 306, R, 306)
note(c, L, 282, CW * 0.45, "what this guard is for",
     "vercel.json gives the function maxDuration:300 and the platform does not negotiate. Max "
     "effort allows four rounds, each waiting up to three minutes for the browser build, so "
     "the process was killed mid-round with the files sitting in memory: no result frame, no "
     "error frame, and a client that threw \"No result came back\" over eleven files it had "
     "just watched get written. Twice in a row, five minutes each, for nothing.", PLANE)
c.setFillColor(MUT); c.setFont(FB, 7.6); c.drawString(L + CW * 0.52, 282, "THE EFFORT SCALE")
table(c, L + CW * 0.52, 264, [92, 96, 112, 190],
      ["level", "max_tokens", "repair rounds", "model tier"],
      [["*fast", "16,000", "1", "eco  -  deepseek-flash"],
       ["*balanced", "32,000", "2", "eco  -  the default"],
       ["*smart", "48,000", "3", "power  -  deepseek-v4-pro"],
       ["*max", "64,000", "4", "power"]])
c.setFillColor(MUT); c.setFont(FO, 8)
c.drawString(L + CW * 0.52, 160, "The reply budget is subtracted twice: once for the reply, once for the attempt being repaired.")
c.drawString(L + CW * 0.52, 148, "Characters convert at 3.0 per token; history caps at 6,000 characters and build errors at 4,000.")
c.showPage()


# ==========================================================  5  activity: publish & deploy
page_frame(c, "Activity  -  publishing, and handing an app to the plane",
           "Two different outputs: static bytes served from the CDN, or a container with a domain of its own.", 5, TOTAL)

# --- the static path, as a strip
c.setFillColor(PLATFORM); c.setFont(FB, 7.6); c.drawString(L, 716, "PUBLISH  -  THE STATIC PATH")
start_node(c, L + 16, 676)
arrow(c, L + 23, 676, L + 44, 676)
action(c, L + 168, 676, 240, 44, "Upload dist as base64",
       "the compiled output has never been on the server")
arrow(c, L + 288, 676, L + 330, 676, "POST /:key/publish", color=PLATFORM, dashed=True)
action(c, L + 500, 676, 300, 44, "Store on the project record",
       "cap measured from the payload, not from what it claims", stroke=PLATFORM)
arrow(c, L + 650, 676, L + 692, 676)
action(c, L + 850, 676, 270, 44, "Served at /s/:slug",
       "own CSP, opaque origin, five minute cache")
arrow(c, L + 985, 676, L + 1010, 676)
end_node(c, L + 1020, 676)
c.setStrokeColor(LINE); c.setLineWidth(0.8); c.line(L, 638, R, 638)

# --- the container path, as swimlanes
LY0, LH = 152, 468
cxs, lw = lanes(c, L, LY0, CW, LH, ["Browser", "Platform function", "Plane API", "Worker"],
                [BROWSER, PLATFORM, PLANE, PLANE])
B, V, P, WK = cxs
aw = 196
rows = [568, 500, 432, 364, 296, 228, 178]

start_node(c, B, rows[0] + 40)
arrow(c, B, rows[0] + 33, B, rows[0] + 21)
action(c, B, rows[0], aw, 38, "Press Deploy")
arrow(c, B + aw / 2, rows[0] - 8, V - aw / 2, rows[1] + 8, "POST /api/deploy/:key/deploy",
      color=PLATFORM, dashed=True, lw=1.3)
action(c, V, rows[1], aw, 44, "materialize() the full source tree",
       "409 if the revision chain cannot reach a root", stroke=PLATFORM)
arrow(c, V, rows[1] - 22, V, rows[2] + 21)
action(c, V, rows[2], aw, 42, "Check the deploy allowance",
       "before anything is created on the plane")
arrow(c, V + aw / 2, rows[2] - 8, P - aw / 2, rows[3] + 8, "two credentials",
      color=PLANE, dashed=True, lw=1.5)
action(c, P, rows[3], aw, 46, "Create project + deployment row",
       "verifies the SAME JWT secret the platform signed", stroke=PLANE)
arrow(c, P, rows[3] - 23, P, rows[4] + 21)
action(c, P, rows[4], aw, 42, "Archive the source to object storage",
       "so a redeploy works weeks later, on another host")
arrow(c, P, rows[4] - 21, P, rows[5] + 19)
action(c, P, rows[5], aw, 38, "Enqueue  -  status QUEUED", stroke=PLANE, bold=True)
arrow(c, P + aw / 2, rows[5] - 6, WK - aw / 2, rows[6] + 12, "polls", color=PLANE, dashed=True)
action(c, WK, rows[6], aw, 48, "SELECT ... FOR UPDATE SKIP LOCKED",
       "and leaves QUEUED in the same transaction", stroke=PLANE, bold=True)
c.setFillColor(INK); c.setFont(FB, 9)
c.drawCentredString(WK, rows[6] - 36, "continued on page 6")

note(c, L, 124, CW * 0.47, "two credentials, two questions",
     "Every call to the plane carries an x-platform-token header - this call came from Souqi - "
     "and the caller's own sq_session cookie, forwarded - and this is who is asking. The plane "
     "verifies that cookie with the same JWT secret the platform signed it with, so there is "
     "one identity across both systems. Both checks apply; neither substitutes for the other.", PLANE)
note(c, L + CW * 0.53, 124, CW * 0.47, "why the claim is transactional",
     "FOR UPDATE SKIP LOCKED is a real work queue: two workers polling the same table never "
     "hand out the same row. Moving it out of QUEUED inside the claiming transaction is what "
     "stops a crash between claiming and building from leaving a deployment invisible to every "
     "worker.", MUT)
c.showPage()


# ==========================================================  6  pipeline state machine
page_frame(c, "The build pipeline as a state machine",
           "QUEUED to RUNNING, and what each transition actually does.", 6, TOTAL)
tp = H - 190
states = [("QUEUED", INK), ("BUILDING", INK), ("STARTING", INK), ("RUNNING", OK)]
sw, gap = 190, (CW - 4 * 190) / 3.0
centres = []
for i, (nm, col_) in enumerate(states):
    x = L + i * (sw + gap)
    centres.append(x + sw / 2)
    c.setStrokeColor(col_); c.setLineWidth(1.6 if nm == "RUNNING" else 1.2)
    c.setFillColor(colors.white)
    c.roundRect(x, tp - 22, sw, 44, 22, stroke=1, fill=1)
    c.setFillColor(col_); c.setFont(FB, 13)
    c.drawCentredString(x + sw / 2, tp - 5, nm)
    if i:
        arrow(c, x - gap + 4, tp, x - 6, tp)

steps = [
 ["admission check  -  capacity.canAdmit()", "the deployment id is passed, so a redeploy is",
  "measured as the replacement it is rather than", "as one more app to find room for"],
 ["restore the source if the build dir is gone", "detect: static / node / nextjs / python",
  "generate a Dockerfile, stage a build context", "build the image INSIDE a container,",
  "never on the host", "audit dependencies - must not affect the outcome"],
 ["provision a per-project Postgres database", "assemble env - SOUQI_DATABASE_URL is always",
  "set and cannot be shadowed; DATABASE_URL only", "if the user has not set their own",
  "run: cap-drop ALL, no-new-privileges,", "read-only root except Next.js, cpu/mem/pids caps"],
 ["attach Caddy to the app's own network", "add one route through Caddy's admin API",
  "watch the container for a few seconds", "only then mark it RUNNING - a container that",
  "exits three seconds in would otherwise leave", "a RUNNING row pointing at nothing"],
]
for i, lines in enumerate(steps):
    x = L + i * (sw + gap)
    c.setStrokeColor(LINE); c.setLineWidth(0.8)
    c.line(x + sw / 2, tp - 24, x + sw / 2, tp - 42)
    c.setFillColor(INK2); c.setFont(F, 8)
    yy = tp - 56
    for ln in lines:
        c.drawString(x - 12, yy, ln); yy -= 11.2

fy = tp - 200
c.setStrokeColor(BAD); c.setLineWidth(1.5); c.setFillColor(colors.white)
c.roundRect(L + CW / 2 - 95, fy - 21, 190, 42, 21, stroke=1, fill=1)
c.setFillColor(BAD); c.setFont(FB, 13); c.drawCentredString(L + CW / 2, fy - 5, "FAILED")
for i, cx_ in enumerate(centres[1:], start=1):
    side = 1 if cx_ > L + CW / 2 else -1
    elbow(c, [(cx_, tp - 148), (cx_, fy + 46), (L + CW / 2 + side * 95, fy + 46),
              (L + CW / 2 + side * 95, fy + 23)], color=BAD, dashed=True)
c.setFillColor(MUT); c.setFont(FO, 8.4)
c.drawCentredString(L + CW / 2, fy - 44,
                    "Everything before the container takes the name over fails without touching what is already serving.")

c.setStrokeColor(LINE); c.setLineWidth(0.8); c.line(L, fy - 76, R, fy - 76)
c.setFillColor(MUT); c.setFont(FB, 7.6); c.drawString(L, fy - 96, "WHAT THE PLANE CAN BUILD")
table(c, L, fy - 114, [150, 250, 250, CW - 650],
      ["framework", "detected by", "built with", "served by"],
      [["*static", "vite or react-scripts + a build script", "node:20-alpine", "nginx:1.27-alpine, unprivileged, :8080"],
       ["*node", "any package.json with a start script", "node:20-alpine", "the app's own server"],
       ["*nextjs", "a next dependency", "node:20-alpine", "next start, writable root for .next"],
       ["*python", "requirements.txt / manage.py / main.py", "python:3.12-slim", "a WSGI or ASGI server"]])
c.setFillColor(MUT); c.setFont(FO, 8)
c.drawString(L, fy - 216, "A project can override all of it with a deploy.json declaring framework, buildCommand, startCommand and port.")
c.showPage()


# ==========================================================  7  isolation
page_frame(c, "Isolation, layer by layer",
           "Three mechanisms stacked on each other: the network, the container runtime, and the database.", 7, TOTAL)

# ---------------- layer 1 : network
c.setFillColor(PLANE); c.setFont(FB, 8)
c.drawString(L, 712, "LAYER 1  ·  NETWORK  ·  three Docker networks, two of them with no route off the box")
PWD = CW * 0.56
c.setFillColor(MUT); c.setFont(F, 8); c.drawString(L + 24, 690, "internet")
arrow(c, L + 38, 684, L + 38, 662)
c.setFillColor(PLANE); c.setFont(FB, 7.4); c.drawString(L + 46, 670, ":80 :443")

c.setStrokeColor(INK); c.setLineWidth(1.1)
c.roundRect(L, 588, PWD, 68, 5, stroke=1, fill=0)
c.setFillColor(MUT); c.setFont(FB, 7); c.drawString(L + 12, 644, "PLATFORM  ·  10.89.0.0/24")
for i, (nm, sub, col_) in enumerate([("caddy", "the only open ports", PLANE),
                                     ("api", "NO docker socket", INK),
                                     ("worker", "holds the socket", PLANE),
                                     ("postgres", "platform data", MUT)]):
    action(c, L + 84 + i * 146, 612, 128, 34, nm, sub, stroke=col_, size=7.8)

c.setStrokeColor(INK); c.setLineWidth(1.1); c.setDash(4, 3)
c.roundRect(L, 500, PWD, 68, 5, stroke=1, fill=0); c.setDash()
c.setFillColor(MUT); c.setFont(FB, 7)
c.drawString(L + 12, 556, "APPS  ·  internal: true  ·  no route off the box")
action(c, L + 84, 524, 128, 34, "caddy", "one join per app", stroke=PLANE, size=7.8)
for i, nm in enumerate(["app A", "app B", "app C"]):
    action(c, L + 230 + i * 146, 524, 128, 34, nm, "no egress", size=7.8)
arrow(c, L + 84, 595, L + 84, 541, color=PLANE)

ux, UW = L + CW * 0.60, CW * 0.40
c.setStrokeColor(INK); c.setLineWidth(1.1); c.setDash(4, 3)
c.roundRect(ux, 500, UW, 156, 5, stroke=1, fill=0); c.setDash()
c.setFillColor(MUT); c.setFont(FB, 7)
c.drawString(ux + 12, 644, "USERDB HOME  ·  internal  ·  a dead end")
action(c, ux + UW / 2, 612, UW - 48, 36, "souqi-userdb",
       "a SEPARATE postgres:16-alpine cluster", stroke=INK, bold=True, size=8)
c.setFillColor(INK2); c.setFont(F, 8)
for i, ln in enumerate(["Nothing here can reach anything, and nothing can reach it.",
                        "The worker talks to it by running psql INSIDE the container,",
                        "over the socket it already holds - never over a network."]):
    c.drawString(ux + 24, 574 - i * 11.4, ln)
elbow(c, [(L + 378, 629), (L + 378, 672), (ux + UW / 2, 672), (ux + UW / 2, 632)],
      "docker exec -i souqi-userdb psql", color=PLANE, dashed=True, lw=1.2)

# ---------------- layer 2 : docker
c.setStrokeColor(LINE); c.setLineWidth(0.8); c.line(L, 482, R, 482)
c.setFillColor(PLANE); c.setFont(FB, 8)
c.drawString(L, 464, "LAYER 2  ·  DOCKER  ·  one process may speak to the daemon, and it never speaks through a shell")
dk = [("The socket is held by exactly one service",
       "The worker mounts /var/run/docker.sock. The api does not, and the compose file says so in as "
       "many words: the control plane must never be able to run a container. A request that reaches "
       "the api can queue work; only the worker can act on it."),
      ("Every docker call is an argv array",
       "engine.js builds arguments as a list and hands them to execFile - never a command string, "
       "never a shell. A project name full of shell metacharacters is an argument, not syntax."),
      ("The image is built inside a container",
       "Never on the host. The build context is scratch: staged, used and wiped afterwards, which is "
       "why a redeploy weeks later restores the source from object storage first."),
      ("The runtime flags are not optional extras",
       "--cap-drop ALL, --security-opt no-new-privileges, a --read-only root (except Next.js, which "
       "caches into .next), and --memory / --cpus / --pids-limit taken from the deployment row.")]
for i, (k, v) in enumerate(dk):
    x = L + (i % 2) * (CW / 2 + 10)
    yy = 442 - (i // 2) * 44
    c.setFillColor(INK); c.setFont(FB, 8.6); c.drawString(x, yy, k)
    c.setFillColor(INK2); c.setFont(F, 8)
    for j, ln in enumerate(wrap(v, F, 8, CW / 2 - 26)[:3]):
        c.drawString(x, yy - 11 - j * 10.2, ln)

# ---------------- layer 3 : postgres
c.setStrokeColor(LINE); c.setLineWidth(0.8); c.line(L, 348, R, 348)
c.setFillColor(PLANE); c.setFont(FB, 8)
c.drawString(L, 330, "LAYER 3  ·  POSTGRES  ·  two clusters, and a tenant that cannot stand anywhere but its own database")

action(c, L + 150, 286, 268, 42, "postgres  -  the platform cluster",
       "deployments, domains, hosts, project env, logs", stroke=MUT, size=8)
action(c, L + 150, 228, 268, 42, "souqi-userdb  -  the customer cluster",
       "one database and one role per project", stroke=INK, bold=True, size=8)
c.setFillColor(MUT); c.setFont(FO, 7.8)
c.drawCentredString(L + 150, 198, "Separate clusters, separate networks. There is no path between them.")

bx = L + 330
c.setFillColor(INK); c.setFont(FB, 8.6)
c.drawString(bx, 308, "Once, for the whole cluster  -  db/userdb-init.sql")
c.setFillColor(INK2)
for i, ln in enumerate(["REVOKE CONNECT ON DATABASE postgres  FROM PUBLIC;",
                        "REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;"]):
    c.setFont("Courier", 7.8); c.drawString(bx + 8, 294 - i * 11, ln)
c.setFont(F, 8); c.setFillColor(MUT)
_blurb = ("Postgres lets PUBLIC connect to the maintenance databases. Left alone a tenant could connect "
          "to postgres instead of its own database and work from there - read the catalogs, create "
          "objects in a shared schema. Its own database being locked down would not matter, because it "
          "never needed to go there. A new database is cloned from template1, so revoking there means "
          "every future tenant inherits the lockdown.")
for i, ln in enumerate(wrap(_blurb, F, 8, CW - 360)[:4]):
    c.drawString(bx + 8, 268 - i * 10.4, ln)

c.setFillColor(INK); c.setFont(FB, 8.6)
c.drawString(bx, 218, "Per project  -  dbproviders/builtin.js")
for i, ln in enumerate(["CREATE ROLE <role> LOGIN PASSWORD <...> CONNECTION LIMIT 20",
                        "CREATE DATABASE <db> OWNER <role>",
                        "REVOKE ALL ON DATABASE <db> FROM PUBLIC",
                        "GRANT CONNECT, TEMPORARY ON DATABASE <db> TO <role>",
                        "REVOKE ALL ON SCHEMA public FROM PUBLIC   ·   ALTER SCHEMA public OWNER TO <role>",
                        "ALTER ROLE <role> SET idle_in_transaction_session_timeout = ..."]):
    c.setFont("Courier", 7.6); c.setFillColor(INK2)
    c.drawString(bx + 8, 204 - i * 11, ln)

note(c, L, 126, CW, "identifiers cannot be parameterised, which is why this code looks the way it does",
     "CREATE DATABASE $1 is not a thing - a placeholder can carry a value but never a name. So the "
     "provider quotes database and role names explicitly rather than interpolating them, and makes "
     "CREATE ROLE idempotent with a DO block, because there is no CREATE ROLE IF NOT EXISTS. The whole "
     "exchange runs through docker exec -i souqi-userdb psql on the socket the worker already holds; "
     "the cluster has no listening port anything could reach.", PLANE)
c.showPage()


# ==========================================================  8  technology
page_frame(c, "Technology, by layer", "Versions as declared in the manifests.", 8, TOTAL)
y = H - 150
c.setFillColor(PLATFORM); c.setFont(FB, 8); c.drawString(L, y, "THE FUNCTION  ·  resolved from the ROOT package.json, because Vercel installs from the repo root")
y = table(c, L, y - 16, [190, 120, CW - 310], ["package", "version", "what it does here"],
      [["*express", "^4.19.2", "the whole HTTP surface; 131 routes in one file"],
       ["*mongodb", "^6.8.0", "projects, revisions, sessions, usage, audit"],
       ["*pg", "^8.22.0", "per-workspace Postgres for customer app data"],
       ["*jsonwebtoken", "^9.0.2", "the sq_session cookie, shared with the deploy plane"],
       ["*bcryptjs", "^2.4.3", "password hashing"],
       ["*@anthropic-ai/sdk", "^0.122.0", "the bring-your-own-key path; Souqi's own routes are plain HTTP"],
       ["*archiver", "^7.0.1", "zip export; root-only, the one dependency backend/ does not declare"],
       ["*cross-spawn / cors / dotenv", "-", "process spawning, CORS, and env loaded from an explicit path"]])

y -= 34
c.setFillColor(MUT); c.setFont(FB, 8); c.drawString(L, y, "THE BROWSER  ·  no build step; what is in frontend/ is what is served")
y = table(c, L, y - 16, [190, 120, CW - 310], ["", "", ""],
      [["*@webcontainer/api", "1.x", "the build sandbox, from cdn.jsdelivr.net as an ES module"],
       ["*react / react-dom", "18.3.1 UMD", "the srcdoc preview fallback where SharedArrayBuffer is absent"],
       ["*babel-standalone", "7.24.7", "transpiles the fallback preview in the page"],
       ["*Jost + Inter", "Google Fonts", "display and body; JetBrains Mono is not used by the product"]])

y -= 34
c.setFillColor(PLANE); c.setFont(FB, 8); c.drawString(L, y, "THE PLANE  ·  its own manifest, four dependencies, nothing shared with backend/")
y = table(c, L, y - 16, [190, 120, CW - 310], ["", "", ""],
      [["*express", "^4.19.2", "the control-plane API"],
       ["*pg", "^8.22.0", "the platform cluster; the customer cluster is reached by docker exec"],
       ["*jsonwebtoken", "^9.0.3", "verifies the platform's own session cookie"],
       ["*dotenv", "^17.4.2", "config, loaded relative to the file not the cwd"],
       ["*postgres:16-alpine", "image", "two separate clusters: platform data and customer data"],
       ["*caddy:2-alpine", "image", "TLS and routing, configured through the admin API at runtime"],
       ["*node:20-alpine", "image", "the plane's own api and worker processes"]])

y -= 34
c.setFillColor(INK); c.setFont(FB, 8); c.drawString(L, y, "WHAT THE AGENT WRITES  ·  one fixed stack, so the scaffold, conventions and error signatures are fixed too")
table(c, L, y - 16, [190, 120, CW - 310], ["", "", ""],
      [["*react / react-dom", "^18.3.1", "the generated app"],
       ["*vite", "^5.3.1", "the build; esbuild under it, which is why tsc runs separately"],
       ["*typescript", "^5.5.3", "tsc --noEmit is the type check esbuild does not do"],
       ["*tailwindcss", "^3.4.4", "the config is generated per build from a contrast-checked palette"],
       ["*vite-plugin-pwa", "^0.20.5", "installability for generated apps"]])
c.showPage()


# ==========================================================  9  data & boundaries
page_frame(c, "Where data rests, and what crosses a boundary",
           "Four stores on two machines, with one deliberate separation.", 9, TOTAL)
y = H - 150
c.setFillColor(MUT); c.setFont(FB, 7.6); c.drawString(L, y, "STORES")
y = table(c, L, y - 16, [180, 300, 180, CW - 660],
      ["store", "holds", "lives on", "written by"],
      [["*MongoDB Atlas", "projects, revisions, users, sessions, usage, audit", "external", "the platform function"],
       ["*Postgres  platform", "deployments, domains, hosts, project env, logs", "the VPS", "plane api + worker"],
       ["*Postgres  userdb", "each customer app's own data", "the VPS, isolated network", "worker, via the socket"],
       ["*S3 / R2", "uploaded images, deployment source archives", "external", "both systems"],
       ["*the project record", "published dist bytes, base64", "MongoDB", "the browser, on publish"]])

y -= 40
c.setFillColor(MUT); c.setFont(FB, 7.6); c.drawString(L, y, "WHAT NEVER MOVES")
items = [("Image bytes", "Uploaded once and referenced by id on every subsequent turn - the composer sends ids, never bytes."),
         ("API keys", "A bring-your-own key is stored server-side on the account. The browser sends an intent, not a credential."),
         ("Compiled output", "Built and previewed entirely in the browser. It reaches the server only when someone presses publish."),
         ("Between the two Postgres clusters", "There is no path. Not a permission grant - no network, no route, no shared cluster.")]
yy = y - 18
for k, v in items:
    c.setFillColor(INK); c.setFont(FB, 9.6); c.drawString(L, yy, k)
    c.setFillColor(INK2); c.setFont(F, 8.6)
    for ln in wrap(v, F, 8.6, CW - 300):
        c.drawString(L + 290, yy, ln); yy -= 11
    yy -= 12

y = yy - 16
c.setStrokeColor(LINE); c.setLineWidth(0.8); c.line(L, y + 8, R, y + 8)
note(c, L, y - 12, CW * 0.47, "verifying a deploy",
     "A route that answers, a page that loads, a 401 where you expected one - none of these "
     "distinguish the new deploy from the one before it. Check a marker that exists only in "
     "the new code, or compare the served byte count against the local file.", PLATFORM)
note(c, L + CW * 0.53, y - 12, CW * 0.47, "schema changes on the plane",
     "db/schema.sql is applied by docker-entrypoint-initdb.d, which only runs against a FRESH "
     "Postgres volume. An existing host never picks up a schema change from a ship alone - it "
     "needs docker compose exec -T api node scripts/migrate.js run explicitly.", PLANE)
c.showPage()

c.save()
print("wrote", OUT, "-", TOTAL, "pages")
