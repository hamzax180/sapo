#!/usr/bin/env bash
# =================================================================
#  backup.sh — dump the platform database
#  -----------------------------------------------------------------
#  Runs ON the server, from the stack directory.
#
#    bash scripts/backup.sh                 # one dump, prune old ones
#    bash scripts/backup.sh --install-cron  # nightly at 03:15
#    bash scripts/backup.sh --list
#    bash scripts/backup.sh --restore /opt/platform/backups/x.sql.gz
#
#  What is and is not covered:
#
#    covered      projects, deployments, env vars, domains, logs — the
#                 rows that say which app belongs to whom and how it runs
#    NOT covered  the images themselves, and user source. Source is staged
#                 on this VM (see "Not built yet" in the README), so losing
#                 the box still loses source until S3 upload exists.
#
#  Restoring the database and re-running deploys rebuilds every app, which
#  is why this is the file worth having. It is not a full disaster plan.
# =================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

BACKUP_DIR="${BACKUP_DIR:-/opt/platform/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

# Read from .env rather than taking them as arguments: a password passed on
# a command line is visible in ps output to every process on the box.
env_get() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }
PG_USER="$(env_get POSTGRES_USER)"; PG_USER="${PG_USER:-souqi}"
PG_DB="$(env_get POSTGRES_DB)";     PG_DB="${PG_DB:-souqi_deploy}"

say()  { printf "\n\033[1m%s\033[0m\n" "$*"; }
fail() { printf "\n\033[31m%s\033[0m\n\n" "$*"; exit 1; }

compose() { docker compose "$@"; }

do_backup() {
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"

  compose ps --status running --quiet postgres | grep -q . \
    || fail "postgres is not running. Start the stack first: docker compose up -d"

  local stamp file tmp
  stamp="$(date -u +%Y%m%d-%H%M%S)"
  file="${BACKUP_DIR}/${PG_DB}-${stamp}.sql.gz"
  tmp="${file}.partial"

  say "Dumping ${PG_DB}"
  # -T disables the TTY so this works from cron. The password comes from the
  # container environment, so it is never on this command line.
  if ! compose exec -T postgres pg_dump -U "$PG_USER" -d "$PG_DB" --clean --if-exists \
       | gzip -9 > "$tmp"; then
    rm -f "$tmp"
    fail "pg_dump failed — nothing written"
  fi

  # A truncated dump that looks like a backup is worse than no backup, so
  # verify the gzip stream and the tail marker before adopting the name.
  gzip -t "$tmp" 2>/dev/null || { rm -f "$tmp"; fail "dump is not valid gzip — discarded"; }
  gzip -dc "$tmp" | tail -5 | grep -q "PostgreSQL database dump complete" \
    || { rm -f "$tmp"; fail "dump is truncated — discarded"; }

  mv "$tmp" "$file"
  chmod 600 "$file"
  echo "  $(du -h "$file" | cut -f1)  $file"

  say "Pruning dumps older than ${KEEP_DAYS} days"
  local pruned
  pruned="$(find "$BACKUP_DIR" -name "${PG_DB}-*.sql.gz" -mtime "+${KEEP_DAYS}" -print -delete | wc -l)"
  echo "  removed ${pruned}"
}

do_list() {
  say "Backups in ${BACKUP_DIR}"
  [ -d "$BACKUP_DIR" ] || { echo "  none"; return; }
  ls -lh "$BACKUP_DIR"/*.sql.gz 2>/dev/null | awk '{print "  " $5 "  " $6 " " $7 " " $8 "  " $9}' \
    || echo "  none"
}

do_restore() {
  local src="${1:-}"
  [ -f "$src" ] || fail "no such backup: $src"
  gzip -t "$src" 2>/dev/null || fail "$src is not a valid gzip file"

  # Restoring overwrites live data, so it asks even though nothing else here
  # is interactive. Cron never reaches this path.
  printf "\n\033[31mThis REPLACES the current contents of %s.\033[0m\n" "$PG_DB"
  printf "Running deployments keep running; their rows are overwritten.\n\n"
  read -r -p "Type the database name to confirm: " answer
  [ "$answer" = "$PG_DB" ] || fail "cancelled"

  say "Restoring ${src}"
  gzip -dc "$src" | compose exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 \
    || fail "restore failed — the database may be half-written; restore again from a known-good dump"

  say "Restarting api and worker"
  compose restart api worker
  echo "  done"
}

install_cron() {
  local job="15 3 * * * cd ${HERE} && /usr/bin/env bash scripts/backup.sh >> /var/log/souqi-backup.log 2>&1"
  # Idempotent: strip any previous line for this script before adding.
  ( crontab -l 2>/dev/null | grep -v "scripts/backup.sh" ; echo "$job" ) | crontab -
  say "Installed"
  echo "  15 3 * * *  ->  ${BACKUP_DIR}"
  echo "  log: /var/log/souqi-backup.log"
  echo ""
  echo "  Dumps live on the same disk as the database. That covers a bad"
  echo "  migration or a dropped table, not a lost VM. Copy them off the box"
  echo "  as well once there is anything in here worth keeping."
}

case "${1:-}" in
  --install-cron) install_cron ;;
  --list)         do_list ;;
  --restore)      do_restore "${2:-}" ;;
  "")             do_backup ;;
  *)              fail "unknown option: $1" ;;
esac
