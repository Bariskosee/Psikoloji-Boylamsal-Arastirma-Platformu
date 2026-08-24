#!/bin/sh
# Nightly logical backup. Roles are separate because pg_dump intentionally
# omits them; both artifacts are required for a valid restore drill.
set -eu
umask 077

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ENV_FILE=${ENV_FILE:-$ROOT/.env.production}
COMPOSE="$ROOT/infrastructure/oracle/compose.sh"
BACKUP_DIR=${BACKUP_DIR:-/var/backups/lpr}
BACKUP_KEEP_DAYS=${BACKUP_KEEP_DAYS:-14}
STATE_DIR=${LPR_OPERATION_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/lpr-oracle}

private_directory() {
  path=$1
  if [ -e "$path" ] || [ -L "$path" ]; then
    [ -d "$path" ] && [ ! -L "$path" ] || {
      echo "$path must be a regular non-symlink directory" >&2
      exit 1
    }
    [ "$(stat -c %u "$path")" = "$(id -u)" ] || {
      echo "$path must be owned by the deployment user" >&2
      exit 1
    }
  else
    mkdir -p "$path"
  fi
  chmod 700 "$path"
}

if [ ! -f "$ENV_FILE" ] || [ -L "$ENV_FILE" ]; then
  echo "missing $ENV_FILE" >&2
  exit 1
fi

case "$BACKUP_KEEP_DAYS" in
  ''|*[!0-9]*) echo "BACKUP_KEEP_DAYS must be a nonnegative integer" >&2; exit 2 ;;
esac
if ! command -v flock >/dev/null 2>&1; then
  echo "backup requires flock (provided by util-linux)" >&2
  exit 1
fi

private_directory "$STATE_DIR"
exec 9>"$STATE_DIR/operation.lock"
flock 9

private_directory "$BACKUP_DIR"
stamp=$(date -u +%Y%m%dT%H%M%SZ)
roles_tmp="$BACKUP_DIR/.roles-$stamp.sql.tmp"
data_tmp="$BACKUP_DIR/.lpr-$stamp.dump.tmp"
environment_tmp="$BACKUP_DIR/.environment-$stamp.production.tmp"
manifest_tmp="$BACKUP_DIR/.manifest-$stamp.sha256.tmp"
latest_tmp="$BACKUP_DIR/.latest.tmp"
roles_final="$BACKUP_DIR/roles-$stamp.sql"
data_final="$BACKUP_DIR/lpr-$stamp.dump"
environment_final="$BACKUP_DIR/environment-$stamp.production"
manifest_final="$BACKUP_DIR/manifest-$stamp.sha256"
latest_final="$BACKUP_DIR/latest"

trap 'rm -f "$roles_tmp" "$data_tmp" "$environment_tmp" "$manifest_tmp" "$latest_tmp"' EXIT HUP INT TERM

"$COMPOSE" exec -T postgres sh -c \
  'pg_dumpall -U "$POSTGRES_USER" --roles-only' >"$roles_tmp"
"$COMPOSE" exec -T postgres sh -c \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' >"$data_tmp"
cp "$ENV_FILE" "$environment_tmp"
chmod 600 "$environment_tmp"

if [ ! -s "$roles_tmp" ] || [ ! -s "$data_tmp" ] || [ ! -s "$environment_tmp" ]; then
  echo "backup failed: one or more dump files are empty" >&2
  exit 1
fi

roles_hash=$(sha256sum "$roles_tmp" | cut -d ' ' -f 1)
data_hash=$(sha256sum "$data_tmp" | cut -d ' ' -f 1)
environment_hash=$(sha256sum "$environment_tmp" | cut -d ' ' -f 1)
printf '%s  %s\n%s  %s\n%s  %s\n' \
  "$roles_hash" "$(basename -- "$roles_final")" \
  "$data_hash" "$(basename -- "$data_final")" \
  "$environment_hash" "$(basename -- "$environment_final")" >"$manifest_tmp"
printf '%s\n' "$stamp" >"$latest_tmp"

mv "$roles_tmp" "$roles_final"
mv "$data_tmp" "$data_final"
mv "$environment_tmp" "$environment_final"
mv "$manifest_tmp" "$manifest_final"
mv "$latest_tmp" "$latest_final"

(cd "$BACKUP_DIR" && sha256sum -c "$(basename -- "$manifest_final")")

deployment_mode_count=$(grep -c '^DEPLOYMENT_MODE=' "$ENV_FILE" || true)
if [ "$deployment_mode_count" -eq 1 ]; then
  deployment_mode=$(sed -n 's/^DEPLOYMENT_MODE=//p' "$ENV_FILE")
else
  deployment_mode=invalid
fi
offsite_status=0
case "$deployment_mode" in
  participant)
    if BACKUP_DIR="$BACKUP_DIR" "$ROOT/infrastructure/oracle/offsite-backup.sh" "$stamp"; then
      :
    else
      offsite_status=$?
      echo "local backup completed, but mandatory off-site upload failed" >&2
    fi
    ;;
  smoke)
    if [ -f "${LPR_RESTIC_CONFIG_DIR:-/etc/lpr/restic}/repository" ]; then
      if BACKUP_DIR="$BACKUP_DIR" "$ROOT/infrastructure/oracle/offsite-backup.sh" "$stamp"; then
        :
      else
        offsite_status=$?
        echo "local backup completed, but configured off-site upload failed" >&2
      fi
    else
      echo "off-site upload skipped in smoke mode; real participant readiness will fail closed"
    fi
    ;;
  *)
    offsite_status=2
    echo "DEPLOYMENT_MODE must be exactly smoke or participant; refusing to skip off-site policy" >&2
    ;;
esac

find "$BACKUP_DIR" -type f -name 'lpr-*.dump' -mtime "+$BACKUP_KEEP_DAYS" -delete
find "$BACKUP_DIR" -type f -name 'roles-*.sql' -mtime "+$BACKUP_KEEP_DAYS" -delete
find "$BACKUP_DIR" -type f -name 'environment-*.production' -mtime "+$BACKUP_KEEP_DAYS" -delete
find "$BACKUP_DIR" -type f -name 'manifest-*.sha256' -mtime "+$BACKUP_KEEP_DAYS" -delete

trap - EXIT HUP INT TERM

if [ "$offsite_status" -ne 0 ]; then
  exit "$offsite_status"
fi

echo "backup ok: $stamp ($(du -h "$data_final" | cut -f1))"
