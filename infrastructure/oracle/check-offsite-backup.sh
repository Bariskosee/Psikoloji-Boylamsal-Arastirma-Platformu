#!/bin/sh
# Weekly structural repository check. Full pack reads are intentionally left to
# an operator-approved schedule because they can consume transfer/request quota.
set -eu
umask 077

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
RESTIC="$ROOT/infrastructure/oracle/restic-command.py"
STATE_DIR=${BACKUP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/lpr-backup}
ENV_FILE=${ENV_FILE:-$ROOT/.env.production}
CONFIG_DIR=${LPR_RESTIC_CONFIG_DIR:-/etc/lpr/restic}
APPROVAL_VALIDATOR="$ROOT/infrastructure/oracle/validate-restic-approval.py"

deployment_mode=$(sed -n 's/^DEPLOYMENT_MODE=//p' "$ENV_FILE" 2>/dev/null | tail -n 1)
if [ ! -f "$CONFIG_DIR/repository" ]; then
  case "$deployment_mode" in
    ''|smoke)
      echo "Restic check skipped: no remote repository in smoke mode"
      exit 0
      ;;
    participant) ;;
    *)
      echo "DEPLOYMENT_MODE must be exactly smoke or participant" >&2
      exit 2
      ;;
  esac
fi

if [ -e "$STATE_DIR" ] || [ -L "$STATE_DIR" ]; then
  [ -d "$STATE_DIR" ] && [ ! -L "$STATE_DIR" ] || {
    echo "$STATE_DIR must be a regular non-symlink directory" >&2
    exit 1
  }
  [ "$(stat -c %u "$STATE_DIR")" = "$(id -u)" ] || {
    echo "$STATE_DIR must be owned by the deployment user" >&2
    exit 1
  }
else
  mkdir -p "$STATE_DIR"
fi
chmod 700 "$STATE_DIR"
exec 8>"$STATE_DIR/offsite.lock"
flock 8

repository_limit=$("$APPROVAL_VALIDATOR" --get MAX_REPOSITORY_BYTES)

"$RESTIC" check

marker_tmp="$STATE_DIR/.restic-check.tmp.$$"
stats_output=$(mktemp "${TMPDIR:-/tmp}/lpr-restic-check-stats.XXXXXX")
trap 'rm -f "$marker_tmp" "$stats_output"' EXIT HUP INT TERM
"$RESTIC" stats --mode raw-data --json >"$stats_output"
repository_bytes=$(python3 - "$stats_output" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    total_size = json.load(source).get("total_size")
if not isinstance(total_size, int) or isinstance(total_size, bool) or total_size < 0:
    raise SystemExit("restic stats did not report a nonnegative total_size")
print(total_size)
PY
)
[ "$repository_bytes" -le "$repository_limit" ] || {
  echo "off-site repository uses $repository_bytes bytes, above the local preflight threshold MAX_REPOSITORY_BYTES=$repository_limit" >&2
  exit 1
}
printf 'completed_at=%s\nrepository_bytes=%s\nmax_repository_bytes=%s\n' \
  "$(date +%s)" "$repository_bytes" "$repository_limit" >"$marker_tmp"
mv "$marker_tmp" "$STATE_DIR/restic-check-success"
trap - EXIT HUP INT TERM
rm -f "$stats_output"
echo "restic repository structural check ok"
