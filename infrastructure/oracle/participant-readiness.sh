#!/bin/sh
# Fail-closed gate for enrolling real participants. Smoke deployments continue
# to use verify.sh; this command additionally proves stable origins, bounded
# recovery, fresh encrypted off-site backup and recent restore evidence.
set -eu
umask 077

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ENV_FILE=${ENV_FILE:-$ROOT/.env.production}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/lpr}
RESTIC="$ROOT/infrastructure/oracle/restic-command.py"
STATE_DIR=${BACKUP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/lpr-backup}
RECOVERY_STATE_DIR=${RECOVERY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/lpr-oracle-recovery}
APPROVAL_VALIDATOR="$ROOT/infrastructure/oracle/validate-restic-approval.py"
MAX_BACKUP_AGE_SECONDS=${MAX_BACKUP_AGE_SECONDS:-93600}
MAX_CHECK_AGE_SECONDS=${MAX_CHECK_AGE_SECONDS:-604800}
MAX_DRILL_AGE_SECONDS=${MAX_DRILL_AGE_SECONDS:-7776000}
MAX_APPROVAL_AGE_SECONDS=${MAX_APPROVAL_AGE_SECONDS:-2592000}
MAX_RECOVERY_SUCCESS_AGE_SECONDS=${MAX_RECOVERY_SUCCESS_AGE_SECONDS:-300}

not_ready() {
  echo "NOT READY FOR REAL PARTICIPANTS: $*" >&2
  exit 1
}

env_value() {
  key=$1
  count=$(grep -c "^$key=" "$ENV_FILE" || true)
  [ "$count" -eq 1 ] || not_ready "$ENV_FILE must contain exactly one $key"
  sed -n "s/^$key=//p" "$ENV_FILE"
}

private_directory() {
  path=$1
  [ -d "$path" ] && [ ! -L "$path" ] || not_ready "$path must be a regular non-symlink directory"
  [ "$(stat -c %u "$path")" = "$(id -u)" ] || not_ready "$path must be owned by the deployment user"
  [ "$(stat -c %a "$path")" = "700" ] || not_ready "$path must have mode 700"
}

private_file() {
  path=$1
  [ -f "$path" ] && [ ! -L "$path" ] || not_ready "$path must be a regular non-symlink file"
  [ "$(stat -c %u "$path")" = "$(id -u)" ] || not_ready "$path must be owned by the deployment user"
  [ "$(stat -c %a "$path")" = "600" ] || not_ready "$path must have mode 600"
  [ -s "$path" ] || not_ready "$path must not be empty"
}

marker_value() {
  file=$1
  key=$2
  count=$(grep -c "^$key=" "$file" || true)
  [ "$count" -eq 1 ] || not_ready "$file must contain exactly one $key"
  value=$(sed -n "s/^$key=//p" "$file")
  [ -n "$value" ] || not_ready "$file is missing $key"
  printf '%s\n' "$value"
}

assert_fresh_epoch() {
  label=$1
  epoch=$2
  maximum_age=$3
  case "$epoch" in ''|*[!0-9]*) not_ready "$label has an invalid timestamp" ;; esac
  age=$(($(date +%s) - epoch))
  [ "$age" -ge 0 ] && [ "$age" -le "$maximum_age" ] || not_ready "$label is stale or from the future"
}

for maximum_age in "$MAX_BACKUP_AGE_SECONDS" "$MAX_CHECK_AGE_SECONDS" "$MAX_DRILL_AGE_SECONDS" "$MAX_APPROVAL_AGE_SECONDS" "$MAX_RECOVERY_SUCCESS_AGE_SECONDS"; do
  case "$maximum_age" in ''|*[!0-9]*) not_ready "freshness limits must be nonnegative integers" ;; esac
done

private_file "$ENV_FILE"
private_directory "$BACKUP_DIR"
private_directory "$STATE_DIR"
exec 8>"$STATE_DIR/offsite.lock"
flock -n 8 || not_ready "another off-site backup operation is running"

deployment_mode=$(env_value DEPLOYMENT_MODE)
origin_mode=$(env_value ORIGIN_MODE)
acme_email=$(env_value ACME_EMAIL)
[ "$deployment_mode" = "participant" ] || not_ready "DEPLOYMENT_MODE must be participant"
case "$origin_mode" in domain|reserved-ip) ;; *) not_ready "origin must be a stable domain or reserved IP" ;; esac
[ -n "$acme_email" ] || not_ready "ACME_EMAIL is required"
if [ "$origin_mode" = "domain" ]; then
  for host_key in API_HOST PARTICIPANT_HOST RESEARCHER_HOST; do
    case "$(env_value "$host_key")" in *.sslip.io|sslip.io) not_ready "$host_key is not a stable domain" ;; esac
  done
fi

repository_limit=$(MAX_APPROVAL_AGE_SECONDS="$MAX_APPROVAL_AGE_SECONDS" \
  "$APPROVAL_VALIDATOR" --require-stable-origin --get MAX_REPOSITORY_BYTES) || \
  not_ready "cost, enforced no-overage, repository, residency or stable-origin approval is invalid"

"$RESTIC" cat config >/dev/null || not_ready "Restic repository is unreachable or uninitialized"
repository_stats_json=$("$RESTIC" stats --mode raw-data --json) || not_ready "Restic repository size is unavailable"
repository_bytes=$(python3 -c '
import json, sys
value = json.loads(sys.argv[1]).get("total_size")
if not isinstance(value, int) or isinstance(value, bool) or value < 0:
    raise SystemExit("invalid total_size")
print(value)
' "$repository_stats_json") || not_ready "Restic repository size is invalid"
[ "$repository_bytes" -le "$repository_limit" ] || \
  not_ready "Restic repository uses $repository_bytes bytes, above the local preflight threshold MAX_REPOSITORY_BYTES=$repository_limit"

systemctl --user is-enabled --quiet lpr-health-recovery.timer || not_ready "health recovery timer is not enabled"
systemctl --user is-active --quiet lpr-health-recovery.timer || not_ready "health recovery timer is not active"
linger=$(loginctl show-user "$(id -u)" --property=Linger --value 2>/dev/null) || \
  not_ready "cannot verify systemd user lingering"
[ "$linger" = "yes" ] || not_ready "systemd user lingering is not enabled"
private_directory "$RECOVERY_STATE_DIR"
watchdog_marker="$RECOVERY_STATE_DIR/health-recovery-success"
private_file "$watchdog_marker"
[ "$(wc -l <"$watchdog_marker" | tr -d ' ')" -eq 1 ] || \
  not_ready "health recovery success marker must contain exactly one line"
assert_fresh_epoch "health recovery watchdog" \
  "$(marker_value "$watchdog_marker" completed_at)" "$MAX_RECOVERY_SUCCESS_AGE_SECONDS"
systemctl --user is-enabled --quiet lpr-backup.timer || not_ready "nightly backup timer is not enabled"
systemctl --user is-active --quiet lpr-backup.timer || not_ready "nightly backup timer is not active"
systemctl --user is-enabled --quiet lpr-restic-check.timer || not_ready "Restic check timer is not enabled"
systemctl --user is-active --quiet lpr-restic-check.timer || not_ready "Restic check timer is not active"

latest="$BACKUP_DIR/latest"
private_file "$latest"
[ "$(wc -l <"$latest" | tr -d ' ')" -eq 1 ] || not_ready "local latest marker must contain exactly one line"
stamp=$(sed -n '1p' "$latest")
case "$stamp" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) not_ready "local latest marker is invalid" ;;
esac
local_epoch=$(python3 - "$stamp" <<'PY'
from datetime import datetime, timezone
import sys
print(int(datetime.strptime(sys.argv[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc).timestamp()))
PY
)
assert_fresh_epoch "local backup" "$local_epoch" "$MAX_BACKUP_AGE_SECONDS"

manifest="$BACKUP_DIR/manifest-$stamp.sha256"
private_file "$BACKUP_DIR/roles-$stamp.sql"
private_file "$BACKUP_DIR/lpr-$stamp.dump"
private_file "$BACKUP_DIR/environment-$stamp.production"
private_file "$manifest"
(cd "$BACKUP_DIR" && sha256sum -c "$(basename -- "$manifest")") >/dev/null || not_ready "local backup manifest failed"

offsite_marker="$STATE_DIR/offsite-success"
private_file "$offsite_marker"
snapshot_id=$(marker_value "$offsite_marker" snapshot_id)
remote_stamp=$(marker_value "$offsite_marker" stamp)
offsite_completed_at=$(marker_value "$offsite_marker" completed_at)
marker_manifest_hash=$(marker_value "$offsite_marker" manifest_sha256)
marker_environment_hash=$(marker_value "$offsite_marker" environment_sha256)
marker_repository_bytes=$(marker_value "$offsite_marker" repository_bytes)
marker_repository_limit=$(marker_value "$offsite_marker" max_repository_bytes)
case "$snapshot_id" in *[!0-9a-f]*|'') not_ready "off-site snapshot id is invalid" ;; esac
[ "${#snapshot_id}" -eq 64 ] || not_ready "off-site snapshot id is invalid"
case "$marker_manifest_hash:$marker_environment_hash" in
  *[!0-9a-f:]*|*:*:*|'') not_ready "off-site marker hashes are invalid" ;;
esac
[ "${#marker_manifest_hash}" -eq 64 ] && [ "${#marker_environment_hash}" -eq 64 ] || \
  not_ready "off-site marker hashes are invalid"
case "$marker_repository_bytes:$marker_repository_limit" in
  *[!0-9:]*|*:*:*|:*|*:) not_ready "off-site marker repository bounds are invalid" ;;
esac
[ "$marker_repository_limit" = "$repository_limit" ] || \
  not_ready "off-site backup used a different repository preflight threshold"
[ "$marker_repository_bytes" -le "$repository_limit" ] || \
  not_ready "off-site success marker exceeds the repository preflight threshold"
[ "$remote_stamp" = "$stamp" ] || not_ready "latest local transaction is not the uploaded off-site transaction"
[ "$(sha256sum "$manifest" | cut -d ' ' -f 1)" = "$marker_manifest_hash" ] || \
  not_ready "local manifest does not match the off-site success marker"
[ "$(sha256sum "$BACKUP_DIR/environment-$stamp.production" | cut -d ' ' -f 1)" = "$marker_environment_hash" ] || \
  not_ready "local environment does not match the off-site success marker"
assert_fresh_epoch "off-site upload completion" "$offsite_completed_at" "$MAX_BACKUP_AGE_SECONDS"

snapshot_json=$(mktemp "${TMPDIR:-/tmp}/lpr-snapshot.XXXXXX")
drill_snapshot_json=$(mktemp "${TMPDIR:-/tmp}/lpr-drill-snapshot.XXXXXX")
restore_dir=$(mktemp -d "${TMPDIR:-/tmp}/lpr-readiness.XXXXXX")
chmod 700 "$restore_dir"
cleanup() {
  rm -f "$snapshot_json" "$drill_snapshot_json"
  case "$restore_dir" in
    "${TMPDIR:-/tmp}"/lpr-readiness.*) rm -rf -- "$restore_dir" ;;
    *) echo "refusing to remove unexpected readiness path: $restore_dir" >&2 ;;
  esac
}
trap cleanup EXIT HUP INT TERM

"$RESTIC" snapshots --json "$snapshot_id" >"$snapshot_json" || not_ready "off-site snapshot is missing"
remote_epoch=$(python3 - "$snapshot_json" "$snapshot_id" "$stamp" <<'PY'
from datetime import datetime
import json
import sys

snapshots = json.load(open(sys.argv[1], encoding="utf-8"))
matching = [item for item in snapshots if item.get("id") == sys.argv[2]]
required_tags = {"lpr-nightly", f"lpr-{sys.argv[3]}"}
if (
    len(matching) != 1
    or matching[0].get("hostname") != "lpr-oracle-prod"
    or not required_tags.issubset(set(matching[0].get("tags", [])))
):
    raise SystemExit("snapshot id/tag mismatch")
print(int(datetime.fromisoformat(matching[0]["time"].replace("Z", "+00:00")).timestamp()))
PY
) || not_ready "off-site snapshot metadata is invalid"
assert_fresh_epoch "off-site backup" "$remote_epoch" "$MAX_BACKUP_AGE_SECONDS"

"$RESTIC" restore "$snapshot_id" --target "$restore_dir" >/dev/null || not_ready "off-site snapshot restore failed"
for name in "roles-$stamp.sql" "lpr-$stamp.dump" "environment-$stamp.production" "manifest-$stamp.sha256"; do
  count=$(find "$restore_dir" -type f -name "$name" | wc -l | tr -d ' ')
  [ "$count" -eq 1 ] || not_ready "restored snapshot is missing exactly one $name"
done
restored_manifest=$(find "$restore_dir" -type f -name "manifest-$stamp.sha256")
restored_dir=$(dirname -- "$restored_manifest")
(cd "$restored_dir" && sha256sum -c "$(basename -- "$restored_manifest")") >/dev/null || not_ready "restored manifest failed"
restored_environment=$(find "$restore_dir" -type f -name "environment-$stamp.production")
[ "$(sha256sum "$restored_manifest" | cut -d ' ' -f 1)" = "$marker_manifest_hash" ] || \
  not_ready "restored manifest does not match the off-site success marker"
[ "$(sha256sum "$restored_environment" | cut -d ' ' -f 1)" = "$marker_environment_hash" ] || \
  not_ready "restored environment does not match the off-site success marker"
[ "$(sha256sum "$restored_environment" | cut -d ' ' -f 1)" = "$(sha256sum "$ENV_FILE" | cut -d ' ' -f 1)" ] || \
  not_ready "off-site secret bundle does not match current production secrets"

check_marker="$STATE_DIR/restic-check-success"
private_file "$check_marker"
assert_fresh_epoch "Restic structural check" "$(marker_value "$check_marker" completed_at)" "$MAX_CHECK_AGE_SECONDS"
[ "$(marker_value "$check_marker" max_repository_bytes)" = "$repository_limit" ] || \
  not_ready "Restic structural check used a different repository preflight threshold"
checked_repository_bytes=$(marker_value "$check_marker" repository_bytes)
case "$checked_repository_bytes" in ''|*[!0-9]*) not_ready "Restic structural check repository size is invalid" ;; esac
[ "$checked_repository_bytes" -le "$repository_limit" ] || \
  not_ready "Restic structural check exceeded the repository preflight threshold"

drill_marker="$STATE_DIR/restore-drill-success"
private_file "$drill_marker"
assert_fresh_epoch "PostgreSQL restore drill" "$(marker_value "$drill_marker" completed_at)" "$MAX_DRILL_AGE_SECONDS"
drill_snapshot=$(marker_value "$drill_marker" snapshot_id)
drill_stamp=$(marker_value "$drill_marker" stamp)
case "$drill_snapshot" in *[!0-9a-f]*|'') not_ready "restore-drilled snapshot id is invalid" ;; esac
[ "${#drill_snapshot}" -eq 64 ] || not_ready "restore-drilled snapshot id is invalid"
case "$drill_stamp" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) not_ready "restore-drilled backup timestamp is invalid" ;;
esac
"$RESTIC" snapshots --json "$drill_snapshot" >"$drill_snapshot_json" || not_ready "restore-drilled snapshot no longer exists"
python3 - "$drill_snapshot_json" "$drill_snapshot" "$drill_stamp" <<'PY' || \
  not_ready "restore-drilled snapshot metadata is invalid"
import json
import sys

snapshots = json.load(open(sys.argv[1], encoding="utf-8"))
matching = [item for item in snapshots if item.get("id") == sys.argv[2]]
required_tags = {"lpr-nightly", f"lpr-{sys.argv[3]}"}
if (
    len(matching) != 1
    or matching[0].get("hostname") != "lpr-oracle-prod"
    or not required_tags.issubset(set(matching[0].get("tags", [])))
):
    raise SystemExit("snapshot id/tag mismatch")
PY
[ "$(marker_value "$drill_marker" structural_checks)" = "ok" ] || not_ready "restore drill structural checks are absent"
[ "$(marker_value "$drill_marker" analytics_research)" = "allowed" ] || not_ready "restore drill research allow check is absent"
[ "$(marker_value "$drill_marker" analytics_identity)" = "denied" ] || not_ready "restore drill identity deny check is absent"

if ! "$ROOT/infrastructure/oracle/verify.sh"; then
  not_ready "runtime deployment verification failed"
fi
echo "READY FOR REAL PARTICIPANTS: stable origins, bounded recovery, fresh encrypted off-site backup and restore evidence passed"
