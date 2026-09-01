#!/usr/bin/env bash
# =================================================================
#  ship.sh — put the stack on the Hetzner host and start it
#  -----------------------------------------------------------------
#  Idempotent. Safe to re-run after a code change: it re-syncs, then
#  rebuilds and restarts only what changed. Running it twice in a row
#  does nothing the second time.
#
#    bash scripts/ship.sh 203.0.113.10
#    bash scripts/ship.sh 203.0.113.10 --logs
#
#  What it deliberately does NOT do: generate secrets on the server.
#  .env is built locally, checked, and copied — so the values live
#  somewhere you control rather than being invented on a box you might
#  later rebuild.
# =================================================================
set -euo pipefail

HOST="${1:-}"
SSH_USER="${SSH_USER:-root}"
REMOTE_DIR="/opt/platform/stack"

if [ -z "$HOST" ]; then
  echo "usage: bash scripts/ship.sh <server-ip> [--logs]"
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

say()  { printf "\n\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\n\033[31m%s\033[0m\n\n" "$*"; exit 1; }

# ---- local checks first: never touch the server with a broken config ----
# All of these gate the ship. A weak secret or a localhost domain is far
# cheaper to catch here than after it is live on a box with a public IP.
PREFLIGHT_TARGET=server node scripts/preflight.js || exit 1


say "Running the verification suites"
node scripts/verify.js      > /dev/null || fail "security checks failed — not shipping"
node scripts/verify-auth.js > /dev/null || fail "session checks failed — not shipping"
echo "  71 checks passed"

# ---- remote ----
SSH="ssh -o StrictHostKeyChecking=accept-new ${SSH_USER}@${HOST}"

say "Checking the server"
$SSH "command -v docker >/dev/null" \
  || fail "docker is not on the server yet. cloud-init may still be running — wait a minute and re-run."
DOCKER_V="$($SSH 'docker --version')"
echo "  $DOCKER_V"
$SSH "docker compose version >/dev/null 2>&1" || fail "docker compose plugin is missing on the server"

say "Copying the stack to ${REMOTE_DIR}"
$SSH "mkdir -p ${REMOTE_DIR} /opt/platform/builds"
# node_modules is rebuilt in the image; .git and builds must never travel.
tar --exclude=node_modules --exclude=.git --exclude=builds --exclude=.env \
    -czf - . | $SSH "tar -xzf - -C ${REMOTE_DIR}"
# .env goes separately with tight permissions — it is the one file that
# matters if this box is ever shared or imaged.
scp -q .env "${SSH_USER}@${HOST}:${REMOTE_DIR}/.env"
$SSH "chmod 600 ${REMOTE_DIR}/.env"
echo "  copied"

say "Building and starting"
$SSH "cd ${REMOTE_DIR} && docker compose up -d --build" 2>&1 | sed 's/^/  /'

say "Waiting for health"
for i in $(seq 1 30); do
  if $SSH "curl -sf localhost:4500/health >/dev/null 2>&1"; then
    echo "  api is up"
    break
  fi
  if [ "$i" -eq 30 ]; then
    fail "the api did not come up. Check: bash scripts/ship.sh $HOST --logs"
  fi
  sleep 2
done

HEALTH="$($SSH 'curl -s localhost:4500/health')"
say "Health"
echo "  $HEALTH"

APP_DOMAIN="$(grep -E '^APP_DOMAIN=' .env | cut -d= -f2-)"
say "Done"
cat <<EOF

  Stack is running on ${HOST}.

  Confirm DNS points at it:
    *.${APP_DOMAIN}   A   ${HOST}

  Then deploy something and watch a real certificate get issued:
    curl -s https://app-xxxx.${APP_DOMAIN}

  Logs:     bash scripts/ship.sh ${HOST} --logs
  Nightly backups (run once):
    ssh ${SSH_USER}@${HOST} 'cd ${REMOTE_DIR} && bash scripts/backup.sh --install-cron'

EOF

if [ "${2:-}" = "--logs" ]; then
  $SSH "cd ${REMOTE_DIR} && docker compose logs -f --tail=100"
fi
