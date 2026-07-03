# MERVEKS SAP — Backend (MongoDB + Node/Express)

This turns the SAP from a single-browser demo into a **real, shared system**:
one database, multi-user, multi-device, with server-verified logins (hashed
passwords) and a server-side Gemini key. The front-end automatically switches
from DEMO to LIVE the moment this API is reachable — **the demo still works
untouched** when the backend is off.

## What it provides

| Endpoint | Purpose |
|---|---|
| `GET /health` | Probe the front-end uses to detect LIVE mode |
| `GET/POST/PUT/DELETE /:collection[/:id]` | CRUD for all 12 collections |
| `POST /auth/login` | Verifies a **hashed** password, returns a token + profile |
| `POST /ai/chat` | Proxies Google Gemini so the API key never ships to the browser |

## 1. Get a database (MongoDB Atlas — free)

1. Create a free account at <https://www.mongodb.com/atlas> and a free **M0** cluster.
2. **Database Access** → add a user + password.
3. **Network Access** → allow your IP (or `0.0.0.0/0` for testing).
4. **Connect → Drivers** → copy the connection string, e.g.
   `mongodb+srv://USER:PASS@cluster0.xxxx.mongodb.net/?retryWrites=true&w=majority`

(Or install MongoDB locally and use `mongodb://127.0.0.1:27017`.)

## 2. Configure

```bash
cd server
cp .env.example .env      # then edit .env
npm install
```

Set in `.env`:
- `MONGODB_URI` — your Atlas/local string
- `JWT_SECRET` — any long random string
- `GEMINI_API_KEY` — optional; enables the live AI Accountant (offline engine works without it)

## 3. Seed the database with the demo data

```bash
npm run seed          # loads the same realistic records as the demo
# npm run seed -- --force   # wipe and re-seed
```

Passwords are **hashed** on the way in. Logins stay the same:
`owner@merveks.com / merveks2013`, `operations@merveks.com / ops123`, etc.

## 4. Run

```bash
npm start             # → http://localhost:4000
```

## 5. Point the front-end at it

Either edit `public/js/config.js` → `API_BASE: "http://localhost:4000"`,
**or** (no redeploy) sign in and go to **Settings → Backend connection**, paste
the URL, and save. The top bar will show **LIVE**. Data now persists in Mongo
and is shared across every device and user.

## Verify it works

```bash
npm run smoke-test    # boots an in-memory Mongo and exercises every endpoint
```

## Notes / next hardening steps
- The CRUD routes are open to any caller that can reach the API. Before going to
  production, gate them behind the JWT from `/auth/login` (middleware checking the
  `Authorization: Bearer` header) and lock `CORS_ORIGIN` to your real site.
- Put the API behind HTTPS (Render, Railway, Fly.io, or a VPS + Caddy/Nginx).
