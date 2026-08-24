#!/bin/sh
# Upload one validated local backup transaction to a client-side encrypted,
# operator-approved remote Restic repository. Never initializes repositories.
set -eu
umask 077

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <YYYYmmddTHHMMSSZ>" >&2
  exit 2
fi

stamp=$1
case "$stamp" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) echo "invalid backup timestamp: $stamp" >&2; exit 2 ;;
esac

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
BACKUP_DIR=${BACKUP_DIR:-/var/backups/lpr}
RESTIC="$ROOT/infrastructure/oracle/restic-command.py"
STATE_DIR=${BACKUP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/lpr-backup}
REPOSITORY_SAFETY_MARGIN_BYTES=67108864
APPROVAL_VALIDATOR="$ROOT/infrastructure/oracle/validate-restic-approval.py"

private_file() {
  path=$1
  if [ ! -f "$path" ] || [ -L "$path" ] || [ ! -s "$path" ]; then
    echo "missing, empty, or unsafe backup artifact: $path" >&2
    exit 1
  fi
  [ "$(stat -c %u "$path")" = "$(id -u)" ] || {
    echo "backup artifact must be owned by the deployment user: $path" >&2
    exit 1
  }
  [ "$(stat -c %a "$path")" = "600" ] || {
    echo "backup artifact must have mode 600: $path" >&2
    exit 1
  }
}

roles="$BACKUP_DIR/roles-$stamp.sql"
data="$BACKUP_DIR/lpr-$stamp.dump"
environment="$BACKUP_DIR/environment-$stamp.production"
manifest="$BACKUP_DIR/manifest-$stamp.sha256"

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
if ! flock -n 8; then
  echo "off-site backup already running" >&2
  exit 1
fi

for artifact in "$roles" "$data" "$environment" "$manifest"; do
  private_file "$artifact"
done
repository_limit=$("$APPROVAL_VALIDATOR" --get MAX_REPOSITORY_BYTES)

(cd "$BACKUP_DIR" && sha256sum -c "$(basename -- "$manifest")")
"$RESTIC" cat config >/dev/null

output=$(mktemp "${TMPDIR:-/tmp}/lpr-restic-backup.XXXXXX")
snapshot_output=$(mktemp "${TMPDIR:-/tmp}/lpr-restic-snapshot.XXXXXX")
stats_output=$(mktemp "${TMPDIR:-/tmp}/lpr-restic-stats.XXXXXX")
marker_tmp="$STATE_DIR/.offsite-success.tmp.$$"
trap 'rm -f "$output" "$snapshot_output" "$stats_output" "$marker_tmp"' EXIT HUP INT TERM

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
transaction_bytes=0
for artifact in "$roles" "$data" "$environment" "$manifest"; do
  artifact_bytes=$(wc -c <"$artifact" | tr -d ' ')
  transaction_bytes=$((transaction_bytes + artifact_bytes))
done
projected_bytes=$((repository_bytes + transaction_bytes + REPOSITORY_SAFETY_MARGIN_BYTES))
[ "$projected_bytes" -le "$repository_limit" ] || {
  echo "off-site upload refused: conservative repository projection $projected_bytes exceeds the local preflight threshold MAX_REPOSITORY_BYTES=$repository_limit" >&2
  exit 1
}

(cd "$BACKUP_DIR" && "$RESTIC" backup --json --host lpr-oracle-prod --tag lpr-nightly --tag "lpr-$stamp" -- \
  "$(basename -- "$roles")" \
  "$(basename -- "$data")" \
  "$(basename -- "$environment")" \
  "$(basename -- "$manifest")") >"$output"

snapshot_id=$(python3 - "$output" <<'PY'
import json
import re
import sys

snapshot_id = None
with open(sys.argv[1], encoding="utf-8") as source:
    for line in source:
        message = json.loads(line)
        if message.get("message_type") == "summary":
            snapshot_id = message.get("snapshot_id")
if not isinstance(snapshot_id, str) or re.fullmatch(r"[0-9a-f]{64}", snapshot_id) is None:
    raise SystemExit("restic did not report a snapshot id")
print(snapshot_id)
PY
)

"$RESTIC" snapshots --json "$snapshot_id" >"$snapshot_output"
python3 - "$snapshot_output" "$snapshot_id" "$stamp" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    snapshots = json.load(source)
matching = [snapshot for snapshot in snapshots if snapshot.get("id") == sys.argv[2]]
required_tags = {"lpr-nightly", f"lpr-{sys.argv[3]}"}
if (
    len(matching) != 1
    or matching[0].get("hostname") != "lpr-oracle-prod"
    or not required_tags.issubset(set(matching[0].get("tags", [])))
):
    raise SystemExit("uploaded snapshot metadata did not match the backup transaction")
PY
manifest_hash=$(sha256sum "$manifest" | cut -d ' ' -f 1)
environment_hash=$(sha256sum "$environment" | cut -d ' ' -f 1)
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
  echo "off-site repository exceeded the local preflight threshold MAX_REPOSITORY_BYTES after upload; success marker withheld" >&2
  exit 1
}
completed_at=$(date +%s)
printf 'snapshot_id=%s\nstamp=%s\ncompleted_at=%s\nmanifest_sha256=%s\nenvironment_sha256=%s\nrepository_bytes=%s\nmax_repository_bytes=%s\n' \
  "$snapshot_id" "$stamp" "$completed_at" "$manifest_hash" "$environment_hash" \
  "$repository_bytes" "$repository_limit" >"$marker_tmp"
mv "$marker_tmp" "$STATE_DIR/offsite-success"
trap - EXIT HUP INT TERM
rm -f "$output" "$snapshot_output" "$stats_output"

echo "encrypted off-site backup ok: snapshot ${snapshot_id%${snapshot_id#????????}} ($stamp)"
