#!/bin/sh
# One canonical Compose invocation for scripts and the runbook.
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
ENV_FILE=${ENV_FILE:-$ROOT/.env.production}

exec docker compose \
  --env-file "$ENV_FILE" \
  -f "$ROOT/infrastructure/oracle/docker-compose.production.yml" \
  "$@"
