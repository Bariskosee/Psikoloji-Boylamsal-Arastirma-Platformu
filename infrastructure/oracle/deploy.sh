#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ENV_FILE=${ENV_FILE:-$ROOT/.env.production}
COMPOSE="$ROOT/infrastructure/oracle/compose.sh"

if [ ! -f "$ENV_FILE" ]; then
  echo "missing $ENV_FILE; copy infrastructure/oracle/.env.production.example first" >&2
  exit 1
fi

chmod 600 "$ENV_FILE"
"$COMPOSE" config --quiet
"$COMPOSE" build
"$COMPOSE" up -d postgres

wait_for_health() {
  service=$1
  max_attempts=$2
  container_id=$("$COMPOSE" ps -q "$service")
  if [ -z "$container_id" ]; then
    echo "$service container was not created" >&2
    exit 1
  fi

  attempt=0
  while :; do
    health_status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id")
    if [ "$health_status" = "healthy" ]; then
      break
    fi
    attempt=$((attempt + 1))
    if [ "$attempt" -gt "$max_attempts" ]; then
      echo "$service did not become healthy within $((max_attempts * 5 / 60)) minutes" >&2
      "$COMPOSE" logs "$service" >&2
      exit 1
    fi
    sleep 5
  done
}

wait_for_one_shot() {
  service=$1
  max_attempts=$2
  "$COMPOSE" up -d --no-deps "$service"
  container_id=$("$COMPOSE" ps -aq "$service")
  if [ -z "$container_id" ]; then
    echo "$service container was not created" >&2
    exit 1
  fi

  attempt=0
  while [ "$(docker inspect --format '{{.State.Running}}' "$container_id")" = "true" ]; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt "$max_attempts" ]; then
      echo "$service did not finish within $((max_attempts * 5 / 60)) minutes" >&2
      exit 1
    fi
    sleep 5
  done

  service_exit=$(docker inspect --format '{{.State.ExitCode}}' "$container_id")
  if [ "$service_exit" -ne 0 ]; then
    "$COMPOSE" logs "$service" >&2
    exit "$service_exit"
  fi
}

# Stage one-shot schema work so each timeout starts after its container starts;
# a single `up` call would wait on dependency completion before this script can
# begin monitoring it.
wait_for_health postgres 36
wait_for_one_shot migrate 120
wait_for_one_shot queue-migrate 60

# The successful one-shot gates were checked above. Start long-running services
# without making Compose rerun them as dependencies.
"$COMPOSE" up -d --no-deps api worker participant researcher
for service in api worker participant researcher; do
  wait_for_health "$service" 60
done
"$COMPOSE" up -d --no-deps proxy

"$COMPOSE" ps --all
echo "deployment started; run infrastructure/oracle/verify.sh after TLS is issued"
