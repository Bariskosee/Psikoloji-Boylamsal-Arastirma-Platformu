#!/bin/sh
# Nightly logical backup. Roles are separate because pg_dump intentionally
# omits them; both artifacts are required for a valid restore drill.
set -eu
umask 077

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ENV_FILE=${ENV_FILE:-$ROOT/.env.production}
COMPOSE="$ROOT/infrastructure/oracle/compose.sh"

if [ ! -f "$ENV_FILE" ]; then
  echo "missing $ENV_FILE" >&2
  exit 1
fi

# Read only the two non-secret host-side rotation values. The secrets remain in
# Compose's env-file and are never exported into this script's output.
BACKUP_DIR=$(sed -n 's/^BACKUP_DIR=//p' "$ENV_FILE" | tail -n 1)
BACKUP_KEEP_DAYS=$(sed -n 's/^BACKUP_KEEP_DAYS=//p' "$ENV_FILE" | tail -n 1)
BACKUP_DIR=${BACKUP_DIR:-/var/backups/lpr}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}

mkdir -p "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
roles_tmp="$BACKUP_DIR/.roles-$stamp.sql.tmp"
data_tmp="$BACKUP_DIR/.lpr-$stamp.dump.tmp"
roles_final="$BACKUP_DIR/roles-$stamp.sql"
data_final="$BACKUP_DIR/lpr-$stamp.dump"

trap 'rm -f "$roles_tmp" "$data_tmp"' EXIT HUP INT TERM

"$COMPOSE" exec -T postgres sh -c \
  'pg_dumpall -U "$POSTGRES_USER" --roles-only' >"$roles_tmp"
"$COMPOSE" exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$data_tmp"

if [ ! -s "$roles_tmp" ] || [ ! -s "$data_tmp" ]; then
  echo "backup failed: one or more dump files are empty" >&2
  exit 1
fi

mv "$roles_tmp" "$roles_final"
mv "$data_tmp" "$data_final"
trap - EXIT HUP INT TERM

find "$BACKUP_DIR" -type f -name 'lpr-*.dump' -mtime "+$BACKUP_KEEP_DAYS" -delete
find "$BACKUP_DIR" -type f -name 'roles-*.sql' -mtime "+$BACKUP_KEEP_DAYS" -delete

echo "backup ok: $stamp ($(du -h "$data_final" | cut -f1))"
