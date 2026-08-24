#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ENV_FILE=${ENV_FILE:-$ROOT/.env.production}
COMPOSE="$ROOT/infrastructure/oracle/compose.sh"

if [ ! -f "$ENV_FILE" ]; then
  echo "missing $ENV_FILE" >&2
  exit 1
fi

API_HOST=$(sed -n 's/^API_HOST=//p' "$ENV_FILE" | tail -n 1)
PARTICIPANT_HOST=$(sed -n 's/^PARTICIPANT_HOST=//p' "$ENV_FILE" | tail -n 1)
RESEARCHER_HOST=$(sed -n 's/^RESEARCHER_HOST=//p' "$ENV_FILE" | tail -n 1)

"$COMPOSE" ps --all

assert_running() {
  service=$1
  require_health=$2
  container_id=$("$COMPOSE" ps -q "$service")
  if [ -z "$container_id" ]; then
    echo "$service container is missing" >&2
    exit 1
  fi
  running=$(docker inspect --format '{{.State.Running}}' "$container_id")
  if [ "$running" != "true" ]; then
    echo "$service is not running" >&2
    exit 1
  fi
  if [ "$require_health" = "yes" ]; then
    health_status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")
    if [ "$health_status" != "healthy" ]; then
      echo "$service health is $health_status" >&2
      exit 1
    fi
  fi
}

assert_completed() {
  service=$1
  container_id=$("$COMPOSE" ps -aq "$service")
  if [ -z "$container_id" ]; then
    echo "$service container is missing" >&2
    exit 1
  fi
  service_exit=$(docker inspect --format '{{.State.ExitCode}}' "$container_id")
  if [ "$service_exit" -ne 0 ]; then
    echo "$service exited with $service_exit" >&2
    exit 1
  fi
}

for service in postgres api worker participant researcher; do
  assert_running "$service" yes
done
assert_running proxy no
assert_completed migrate
assert_completed queue-migrate
echo "container lifecycle and health checks ok"

health=$(curl --fail --silent --show-error "https://$API_HOST/health")
ready=$(curl --fail --silent --show-error "https://$API_HOST/ready")

HEALTH_JSON=$health READY_JSON=$ready python3 - <<'PY'
import json
import os

health = json.loads(os.environ["HEALTH_JSON"])
ready = json.loads(os.environ["READY_JSON"])
if health.get("status") not in {"ok", "healthy"}:
    raise SystemExit(f"unexpected /health payload: {health}")
if ready.get("ready") is not True:
    raise SystemExit(f"API is not ready: {ready}")
checks = ready.get("checks", [])
if not checks or not all(check.get("ok") is True for check in checks):
    raise SystemExit(f"one or more /ready checks failed: {ready}")
print("/health and /ready ok")
PY

curl --fail --silent --show-error --output /dev/null "https://$PARTICIPANT_HOST/en"
curl --fail --silent --show-error --output /dev/null "https://$RESEARCHER_HOST/en/login"
echo "participant and researcher HTTPS ok"

"$COMPOSE" exec -T postgres sh -c '
  psql -v ON_ERROR_STOP=1 -v app_user="$APP_DATABASE_USER" \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<"SQL"
SELECT count(*) = 10 AS migrations_ok
  FROM drizzle.__drizzle_migrations
\gset
\if :migrations_ok
\else
  \echo 'expected all 10 application migrations'
  \quit 1
\endif

SELECT COALESCE((
  SELECT NOT rolsuper AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication
    FROM pg_roles
   WHERE rolname = :'"'"'app_user'"'"'
), false) AS runtime_role_ok
\gset
\if :runtime_role_ok
\else
  \echo 'runtime database login is missing or privileged'
  \quit 1
\endif

SELECT pg_has_role(:'"'"'app_user'"'"', '"'"'app_readwrite'"'"', '"'"'MEMBER'"'"')
   AND pg_has_role(:'"'"'app_user'"'"', '"'"'app_analytics'"'"', '"'"'MEMBER'"'"')
   AND NOT has_database_privilege(:'"'"'app_user'"'"', current_database(), '"'"'CREATE'"'"')
  AS role_boundary_ok
\gset
\if :role_boundary_ok
\else
  \echo 'runtime role membership or database CREATE boundary failed'
  \quit 1
\endif

SELECT COALESCE((
  SELECT pg_get_userbyid(nspowner) = :'"'"'app_user'"'"'
    FROM pg_namespace
   WHERE nspname = '"'"'pgboss'"'"'
), false) AS queue_owner_ok
\gset
\if :queue_owner_ok
\else
  \echo 'pgboss schema is not owned by the restricted runtime login'
  \quit 1
\endif

SELECT to_regclass('"'"'pgboss.version'"'"') IS NOT NULL
   AND (SELECT count(*) FROM pgboss.queue
         WHERE name IN ('"'"'notification.send'"'"', '"'"'notification.send.dlq'"'"')) = 2
  AS queue_ok
\gset
\if :queue_ok
\else
  \echo 'pg-boss schema or required queues are missing'
  \quit 1
\endif

SELECT EXISTS (
  SELECT 1
    FROM research.system_heartbeats
   WHERE swept_at > now() - make_interval(secs => sweep_interval_seconds * 3 + 30)
     AND consecutive_failures = 0
     AND last_error IS NULL
) AS heartbeat_ok
\gset
\if :heartbeat_ok
\else
  \echo 'worker heartbeat is stale or reports failures'
  \quit 1
\endif
SQL
'

echo "migration ledger, restricted roles, pg-boss queues and heartbeat ok"

worker_logs=$("$COMPOSE" logs --no-color --since 15m worker)
if printf '%s\n' "$worker_logs" | grep -q 'pg-boss UNAVAILABLE'; then
  echo "worker queue is unavailable" >&2
  exit 1
fi
if ! printf '%s\n' "$worker_logs" | grep -q 'pg-boss connected as queue owner'; then
  echo "worker has not confirmed a pg-boss connection in the last 15 minutes" >&2
  exit 1
fi
echo "worker pg-boss connection ok"

echo "participant: https://$PARTICIPANT_HOST"
echo "researcher:  https://$RESEARCHER_HOST"
echo "api:         https://$API_HOST"
echo "Verify the authenticated Operations page separately: nonempty fresh sweepers, zero failures, empty alerts."
