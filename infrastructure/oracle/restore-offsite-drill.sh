#!/bin/sh
# Restore an encrypted off-site snapshot into an isolated PostgreSQL
# container and record evidence only after structural and privilege checks pass.
# A fresh-VM mode derives the newest authenticated nightly snapshot without local
# state and leaves its verified artifacts in an explicitly private directory.
set -eu
umask 077

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
RESTIC="$ROOT/infrastructure/oracle/restic-command.py"
APPROVAL_VALIDATOR="$ROOT/infrastructure/oracle/validate-restic-approval.py"
STATE_DIR=${BACKUP_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/lpr-backup}
success_marker="$STATE_DIR/offsite-success"
mode=marker
recovery_dir=
recovery_parent=
recovery_tmp=

case "$#" in
  0) ;;
  2)
    [ "$1" = "--fresh-vm-recovery" ] || {
      echo "usage: $0 [--fresh-vm-recovery <new-private-directory>]" >&2
      exit 2
    }
    mode=fresh-vm
    recovery_dir=$2
    [ -n "$recovery_dir" ] || { echo "recovery directory must not be empty" >&2; exit 2; }
    [ ! -e "$recovery_dir" ] && [ ! -L "$recovery_dir" ] || {
      echo "recovery directory already exists: $recovery_dir" >&2
      exit 1
    }
    recovery_parent=$(dirname -- "$recovery_dir")
    [ -d "$recovery_parent" ] && [ ! -L "$recovery_parent" ] || {
      echo "recovery parent must be a regular non-symlink directory: $recovery_parent" >&2
      exit 1
    }
    [ "$(stat -c %u "$recovery_parent")" = "$(id -u)" ] && \
      [ "$(stat -c %a "$recovery_parent")" = "700" ] || {
      echo "recovery parent must be owned by the deployment user with mode 700" >&2
      exit 1
    }
    ;;
  *)
    echo "usage: $0 [--fresh-vm-recovery <new-private-directory>]" >&2
    exit 2
    ;;
esac

if [ ! -e "$STATE_DIR" ] && [ ! -L "$STATE_DIR" ] && [ "$mode" = "fresh-vm" ]; then
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
fi
[ -d "$STATE_DIR" ] && [ ! -L "$STATE_DIR" ] || {
  echo "$STATE_DIR must be a regular non-symlink directory" >&2
  exit 1
}
[ "$(stat -c %u "$STATE_DIR")" = "$(id -u)" ] && [ "$(stat -c %a "$STATE_DIR")" = "700" ] || {
  echo "$STATE_DIR must be owned by the deployment user with mode 700" >&2
  exit 1
}
if [ "$mode" = "marker" ]; then
  if [ ! -f "$success_marker" ] || [ -L "$success_marker" ] || [ ! -s "$success_marker" ]; then
    echo "a successful off-site backup marker is required; use --fresh-vm-recovery only after VM/state loss" >&2
    exit 1
  fi
  [ "$(stat -c %u "$success_marker")" = "$(id -u)" ] && \
    [ "$(stat -c %a "$success_marker")" = "600" ] || {
    echo "$success_marker must be owned by the deployment user with mode 600" >&2
    exit 1
  }
fi

exec 8>"$STATE_DIR/offsite.lock"
if ! flock -n 8; then
  echo "another off-site backup operation is running" >&2
  exit 1
fi
"$APPROVAL_VALIDATOR" >/dev/null

marker_value() {
  key=$1
  count=$(grep -c "^$key=" "$success_marker" || true)
  [ "$count" -eq 1 ] || { echo "expected one $key in $success_marker" >&2; exit 1; }
  value=$(sed -n "s/^$key=//p" "$success_marker")
  [ -n "$value" ] || { echo "missing $key in $success_marker" >&2; exit 1; }
  printf '%s\n' "$value"
}

manifest_hash=
environment_hash=
snapshot_epoch=
if [ "$mode" = "marker" ]; then
  snapshot_id=$(marker_value snapshot_id)
  stamp=$(marker_value stamp)
  manifest_hash=$(marker_value manifest_sha256)
  environment_hash=$(marker_value environment_sha256)
  case "$snapshot_id" in *[!0-9a-f]*|'') echo "invalid snapshot id" >&2; exit 1 ;; esac
  [ "${#snapshot_id}" -eq 64 ] || { echo "invalid snapshot id" >&2; exit 1; }
  case "$manifest_hash:$environment_hash" in
    *[!0-9a-f:]*|*:*:*|'') echo "invalid backup marker hashes" >&2; exit 1 ;;
  esac
  [ "${#manifest_hash}" -eq 64 ] && [ "${#environment_hash}" -eq 64 ] || {
    echo "invalid backup marker hashes" >&2
    exit 1
  }
  case "$stamp" in
    [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
    *) echo "invalid backup timestamp" >&2; exit 1 ;;
  esac
fi

expected_migrations=$(python3 - "$ROOT/packages/db/migrations/meta/_journal.json" <<'PY'
import json
import sys
print(len(json.load(open(sys.argv[1], encoding="utf-8"))["entries"]))
PY
)

restore_dir=$(mktemp -d "${TMPDIR:-/tmp}/lpr-offsite-drill.XXXXXX")
snapshot_output=$(mktemp "${TMPDIR:-/tmp}/lpr-offsite-snapshot.XXXXXX")
chmod 700 "$restore_dir"
if [ "$mode" = "fresh-vm" ]; then
  recovery_tmp=$(mktemp -d "$recovery_parent/.lpr-recovery.XXXXXX")
  chmod 700 "$recovery_tmp"
fi
container="lpr-restore-drill-$$"
container_started=false

cleanup() {
  if [ "$container_started" = "true" ]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  case "$restore_dir" in
    "${TMPDIR:-/tmp}"/lpr-offsite-drill.*) rm -rf -- "$restore_dir" ;;
    *) echo "refusing to remove unexpected restore path: $restore_dir" >&2 ;;
  esac
  rm -f "$snapshot_output"
  if [ -n "$recovery_tmp" ]; then
    case "$recovery_tmp" in
      "$recovery_parent"/.lpr-recovery.*) rm -rf -- "$recovery_tmp" ;;
      *) echo "refusing to remove unexpected recovery path: $recovery_tmp" >&2 ;;
    esac
  fi
}
trap cleanup EXIT HUP INT TERM

if [ "$mode" = "marker" ]; then
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
    raise SystemExit("off-site snapshot metadata does not match its success marker")
PY
else
  "$RESTIC" snapshots --json --host lpr-oracle-prod --tag lpr-nightly >"$snapshot_output"
  selection=$(python3 - "$snapshot_output" <<'PY'
from datetime import datetime
import json
import re
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    snapshots = json.load(source)
if not isinstance(snapshots, list):
    raise SystemExit("Restic snapshots output is not a list")

candidates = []
for snapshot in snapshots:
    snapshot_id = snapshot.get("id")
    tags = snapshot.get("tags")
    if (
        not isinstance(snapshot_id, str)
        or re.fullmatch(r"[0-9a-f]{64}", snapshot_id) is None
        or snapshot.get("hostname") != "lpr-oracle-prod"
        or not isinstance(tags, list)
        or "lpr-nightly" not in tags
    ):
        continue
    transaction_tags = [
        tag
        for tag in tags
        if isinstance(tag, str) and re.fullmatch(r"lpr-[0-9]{8}T[0-9]{6}Z", tag)
    ]
    if len(transaction_tags) != 1:
        continue
    try:
        created = datetime.fromisoformat(snapshot["time"].replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError):
        continue
    if created.utcoffset() is None:
        continue
    candidates.append((created.timestamp(), snapshot_id, transaction_tags[0][4:]))

if not candidates:
    raise SystemExit("no authenticated lpr-nightly snapshot with valid recovery metadata was found")
created_epoch, snapshot_id, stamp = max(candidates)
print(snapshot_id)
print(stamp)
print(int(created_epoch))
PY
  )
  snapshot_id=$(printf '%s\n' "$selection" | sed -n '1p')
  stamp=$(printf '%s\n' "$selection" | sed -n '2p')
  snapshot_epoch=$(printf '%s\n' "$selection" | sed -n '3p')
fi

"$RESTIC" restore "$snapshot_id" --target "$restore_dir"

find_one() {
  pattern=$1
  matches=$(find "$restore_dir" -type f -name "$pattern" -print)
  count=$(printf '%s\n' "$matches" | sed '/^$/d' | wc -l | tr -d ' ')
  if [ "$count" -ne 1 ]; then
    echo "expected one restored $pattern, found $count" >&2
    exit 1
  fi
  printf '%s\n' "$matches"
}

roles=$(find_one "roles-$stamp.sql")
data=$(find_one "lpr-$stamp.dump")
environment=$(find_one "environment-$stamp.production")
manifest=$(find_one "manifest-$stamp.sha256")
artifact_dir=$(dirname -- "$manifest")

for artifact in "$roles" "$data" "$environment" "$manifest"; do
  [ "$(dirname -- "$artifact")" = "$artifact_dir" ] || {
    echo "restored transaction artifacts are not colocated" >&2
    exit 1
  }
done
python3 - "$manifest" "$(basename -- "$roles")" "$(basename -- "$data")" \
  "$(basename -- "$environment")" <<'PY'
import re
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    lines = source.read().splitlines()
expected = set(sys.argv[2:])
parsed = []
for line in lines:
    match = re.fullmatch(r"([0-9a-f]{64})  ([^/]+)", line)
    if match is None:
        raise SystemExit("restored manifest contains an invalid entry")
    parsed.append(match.group(2))
if len(parsed) != 3 or set(parsed) != expected:
    raise SystemExit("restored manifest does not describe exactly the recovery transaction")
PY
(cd "$artifact_dir" && sha256sum -c "$(basename -- "$manifest")")
restored_manifest_hash=$(sha256sum "$manifest" | cut -d ' ' -f 1)
restored_environment_hash=$(sha256sum "$environment" | cut -d ' ' -f 1)
if [ "$mode" = "marker" ]; then
  [ "$restored_manifest_hash" = "$manifest_hash" ] || {
    echo "restored manifest does not match the off-site success marker" >&2
    exit 1
  }
  [ "$restored_environment_hash" = "$environment_hash" ] || {
    echo "restored environment does not match the off-site success marker" >&2
    exit 1
  }
else
  manifest_hash=$restored_manifest_hash
  environment_hash=$restored_environment_hash
fi

app_user_count=$(grep -c '^APP_DATABASE_USER=' "$environment" || true)
[ "$app_user_count" -eq 1 ] || { echo "restored APP_DATABASE_USER is missing or duplicated" >&2; exit 1; }
APP_DATABASE_USER=$(sed -n 's/^APP_DATABASE_USER=//p' "$environment")
[ -n "$APP_DATABASE_USER" ] || { echo "restored APP_DATABASE_USER is empty" >&2; exit 1; }
case "$APP_DATABASE_USER" in *[!A-Za-z0-9_]*) echo "unsafe APP_DATABASE_USER" >&2; exit 1 ;; esac

container_env="$restore_dir/postgres.env"
restore_password=$(openssl rand -hex 32)
printf 'POSTGRES_USER=restore_admin\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=lpr\n' \
  "$restore_password" >"$container_env"
unset restore_password

docker run -d --pull=never --network none --memory=768m --cpus=1 \
  --name "$container" --env-file "$container_env" postgres:16-alpine >/dev/null
container_started=true

attempt=0
until docker exec "$container" pg_isready -h 127.0.0.1 -U restore_admin -d lpr >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 90 ]; then
    echo "restore drill PostgreSQL did not become ready" >&2
    exit 1
  fi
  sleep 1
done

sed '/^GRANT .* GRANTED BY /d' "$roles" | \
  docker exec -i "$container" psql -v ON_ERROR_STOP=1 -U restore_admin -d postgres >/dev/null

docker exec -i "$container" psql -v ON_ERROR_STOP=1 -v app_user="$APP_DATABASE_USER" \
  -U restore_admin -d postgres >/dev/null <<'SQL'
SELECT format('GRANT app_readwrite, app_analytics TO %I', :'app_user')
\gexec
SQL

docker cp "$data" "$container:/tmp/lpr.dump" >/dev/null
docker exec "$container" pg_restore --exit-on-error --clean --if-exists \
  -U restore_admin -d lpr /tmp/lpr.dump >/dev/null

structure=$(docker exec "$container" psql -v ON_ERROR_STOP=1 -At -F, \
  -v expected_migrations="$expected_migrations" -U restore_admin -d lpr <<'SQL'
SELECT
  (SELECT count(*) FROM drizzle.__drizzle_migrations),
  (SELECT count(*) FROM information_schema.tables WHERE table_schema IN ('research','identity')),
  (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal),
  (SELECT count(*) FROM pg_constraint WHERE contype = 'f'),
  (SELECT count(*) FROM research.studies),
  (SELECT count(*) FROM research.participants),
  (SELECT count(*) FROM research.participant_sessions),
  (SELECT count(*) FROM research.responses);

SELECT count(*) = (:expected_migrations)::integer
   AND (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal) > 0
   AND (SELECT count(*) FROM pg_constraint WHERE contype = 'f') > 0
   AND to_regclass('pgboss.version') IS NOT NULL
   AND (SELECT count(*) FROM pgboss.queue
          WHERE name IN ('notification.send', 'notification.send.dlq')) = 2;
SQL
)
assertion=$(printf '%s\n' "$structure" | tail -n 1)
[ "$assertion" = "t" ] || { echo "restored database structural assertions failed" >&2; exit 1; }
counts=$(printf '%s\n' "$structure" | head -n 1)

docker exec "$container" psql -v ON_ERROR_STOP=1 -U restore_admin -d lpr \
  -c 'SET ROLE app_analytics; SELECT count(*) FROM research.studies' >/dev/null
if docker exec "$container" psql -v ON_ERROR_STOP=1 -U restore_admin -d lpr \
  -c 'SET ROLE app_analytics; SELECT count(*) FROM identity.researcher_users' >/dev/null 2>&1; then
  echo "analytics role unexpectedly reached identity schema" >&2
  exit 1
fi

completed_at=$(date +%s)
marker_tmp="$STATE_DIR/.restore-drill-success.tmp.$$"
printf 'snapshot_id=%s\nstamp=%s\ncompleted_at=%s\ncounts=%s\nstructural_checks=ok\nanalytics_research=allowed\nanalytics_identity=denied\n' \
  "$snapshot_id" "$stamp" "$completed_at" "$counts" >"$marker_tmp"
mv "$marker_tmp" "$STATE_DIR/restore-drill-success"

if [ "$mode" = "fresh-vm" ]; then
  for artifact in "$roles" "$data" "$environment" "$manifest"; do
    install -m 600 "$artifact" "$recovery_tmp/$(basename -- "$artifact")"
  done
  repository_file=${LPR_RESTIC_CONFIG_DIR:-/etc/lpr/restic}/repository
  repository_sha256=$(sha256sum "$repository_file" | cut -d ' ' -f 1)
  printf 'recovery_mode=fresh-vm\nsnapshot_id=%s\nstamp=%s\nsnapshot_epoch=%s\ncompleted_at=%s\nmanifest_sha256=%s\nenvironment_sha256=%s\nrepository_sha256=%s\ncounts=%s\nstructural_checks=ok\nanalytics_research=allowed\nanalytics_identity=denied\n' \
    "$snapshot_id" "$stamp" "$snapshot_epoch" "$completed_at" "$manifest_hash" \
    "$environment_hash" "$repository_sha256" "$counts" >"$recovery_tmp/recovery-evidence"
  chmod 600 "$recovery_tmp/recovery-evidence"
  (cd "$recovery_tmp" && sha256sum -c "$(basename -- "$manifest")")
  [ ! -e "$recovery_dir" ] && [ ! -L "$recovery_dir" ] || {
    echo "recovery directory appeared while the drill was running: $recovery_dir" >&2
    exit 1
  }
  mv "$recovery_tmp" "$recovery_dir"
  recovery_tmp=
  echo "fresh-VM recovery drill ok: snapshot ${snapshot_id%${snapshot_id#????????}}; private bundle: $recovery_dir"
else
  echo "off-site PostgreSQL restore drill ok: snapshot ${snapshot_id%${snapshot_id#????????}}"
fi
