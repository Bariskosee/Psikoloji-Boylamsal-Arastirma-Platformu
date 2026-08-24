#!/bin/sh
# React to Docker health failures without granting a container the Docker
# socket. This is run by the user-level systemd timer installed below.
set -eu
umask 077

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
COMPOSE="$ROOT/infrastructure/oracle/compose.sh"
STATE_DIR=${RECOVERY_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/lpr-oracle-recovery}
LOCK_DIR=${LPR_OPERATION_STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/lpr-oracle}
SAMPLE_MIN_SECONDS=${RECOVERY_SAMPLE_MIN_SECONDS:-60}
SAMPLE_MAX_SECONDS=${RECOVERY_SAMPLE_MAX_SECONDS:-180}
COOLDOWN_SECONDS=${RECOVERY_COOLDOWN_SECONDS:-600}
WINDOW_SECONDS=${RECOVERY_WINDOW_SECONDS:-3600}
MAX_SERVICE_RESTARTS=${RECOVERY_MAX_SERVICE_RESTARTS:-3}
MAX_GLOBAL_RESTARTS=${RECOVERY_MAX_GLOBAL_RESTARTS:-5}
MAX_ACTIONS_PER_RUN=${RECOVERY_MAX_ACTIONS_PER_RUN:-2}
WAIT_SECONDS=${RECOVERY_WAIT_SECONDS:-120}

mkdir -p "$STATE_DIR" "$LOCK_DIR"
chmod 700 "$STATE_DIR" "$LOCK_DIR"

if ! command -v flock >/dev/null 2>&1; then
  echo "health recovery requires flock (provided by util-linux)" >&2
  exit 1
fi

# Deploys and backups hold the same lock. A recovery run skips instead of
# interrupting schema work or a consistent logical dump.
exec 9>"$LOCK_DIR/operation.lock"
if ! flock -n 9; then
  echo "health recovery skipped: another deployment operation is active"
  exit 0
fi
if ! "$COMPOSE" ps >/dev/null 2>&1; then
  echo "health recovery cannot query the Compose project" >&2
  exit 1
fi

now=$(date +%s)
cutoff=$((now - WINDOW_SECONDS))
actions=0
failed=0
postgres_id=$("$COMPOSE" ps -q postgres 2>/dev/null || true)
postgres_status=missing
postgres_running=false
if [ -n "$postgres_id" ]; then
  postgres_running=$(docker inspect --format '{{.State.Running}}' "$postgres_id" 2>/dev/null || true)
  postgres_status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$postgres_id" 2>/dev/null || true)
fi
postgres_ready=false
if [ "$postgres_running" = "true" ] && [ "$postgres_status" = "healthy" ]; then
  postgres_ready=true
fi

log_event() {
  level=$1
  service=$2
  event=$3
  printf 'ts=%s level=%s service=%s event=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$level" "$service" "$event"
}

prune_history() {
  history_file=$1
  history_tmp="$history_file.tmp.$$"
  if [ -f "$history_file" ]; then
    if ! awk 'NF != 1 || $1 !~ /^[0-9]+$/ { invalid = 1 } END { exit invalid }' "$history_file"; then
      log_event error state restart_history_corrupt
      return 1
    fi
    awk -v cutoff="$cutoff" '$1 >= cutoff { print $1 }' "$history_file" >"$history_tmp"
  else
    : >"$history_tmp"
  fi
  mv "$history_tmp" "$history_file"
}

record_sample() {
  service=$1
  pending_file="$STATE_DIR/$service.pending"

  if [ ! -f "$pending_file" ]; then
    printf '%s %s %s\n' "$now" "$now" 1 >"$pending_file"
    log_event warn "$service" unhealthy_sample_1
    return 1
  fi

  if ! read -r first_sample last_sample sample_count <"$pending_file"; then
    log_event error "$service" pending_state_corrupt
    return 2
  fi
  case "$first_sample:$last_sample:$sample_count" in
    *[!0-9:]*) log_event error "$service" pending_state_corrupt; return 2 ;;
  esac
  if [ "$sample_count" -lt 1 ] || [ "$first_sample" -gt "$last_sample" ] || [ "$last_sample" -gt "$now" ]; then
    log_event error "$service" pending_state_corrupt
    return 2
  fi
  since_last=$((now - last_sample))
  if [ "$since_last" -lt "$SAMPLE_MIN_SECONDS" ]; then
    return 1
  fi
  if [ "$since_last" -gt "$SAMPLE_MAX_SECONDS" ]; then
    printf '%s %s %s\n' "$now" "$now" 1 >"$pending_file"
    log_event warn "$service" unhealthy_sample_reset
    return 1
  fi

  sample_count=$((sample_count + 1))
  printf '%s %s %s\n' "$first_sample" "$now" "$sample_count" >"$pending_file"
  [ "$sample_count" -ge 2 ]
}

wait_for_health() {
  service=$1
  deadline=$(($(date +%s) + WAIT_SECONDS))
  while [ "$(date +%s)" -le "$deadline" ]; do
    container_id=$("$COMPOSE" ps -q "$service" 2>/dev/null || true)
    if [ -n "$container_id" ]; then
      status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id" 2>/dev/null || true)
      if [ "$status" = "healthy" ]; then
        return 0
      fi
    fi
    sleep 5
  done
  return 1
}

global_history="$STATE_DIR/all.history"
prune_history "$global_history"

# PostgreSQL is intentionally first. It is monitor-only: blindly restarting a
# database on health failure can turn disk exhaustion or recovery into a
# restart loop. Its failure also suppresses dependent API/worker restarts.
for service in postgres api worker participant researcher proxy; do
  container_id=$("$COMPOSE" ps -q "$service" 2>/dev/null || true)
  if [ -z "$container_id" ]; then
    rm -f "$STATE_DIR/$service.pending"
    continue
  fi

  running=$(docker inspect --format '{{.State.Running}}' "$container_id" 2>/dev/null || true)
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$container_id" 2>/dev/null || true)
  labels=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}}' "$container_id" 2>/dev/null || true)
  if [ "$labels" != "lpr-oracle $service" ]; then
    log_event error "$service" compose_identity_mismatch
    failed=1
    continue
  fi
  if [ "$running" != "true" ] || [ "$status" != "unhealthy" ]; then
    rm -f "$STATE_DIR/$service.pending"
    continue
  fi

  if record_sample "$service"; then
    :
  else
    sample_result=$?
    if [ "$sample_result" -eq 2 ]; then
      failed=1
    fi
    continue
  fi

  if [ "$service" = "postgres" ]; then
    log_event error postgres unhealthy_manual_intervention_required
    failed=1
    continue
  fi
  if [ "$postgres_ready" != "true" ] && { [ "$service" = "api" ] || [ "$service" = "worker" ]; }; then
    log_event warn "$service" restart_suppressed_by_postgres
    continue
  fi
  if [ "$actions" -ge "$MAX_ACTIONS_PER_RUN" ]; then
    log_event warn "$service" per_run_limit_reached
    continue
  fi

  service_history="$STATE_DIR/$service.history"
  prune_history "$service_history"
  service_count=$(wc -l <"$service_history" | tr -d ' ')
  global_count=$(wc -l <"$global_history" | tr -d ' ')
  last_restart=$(tail -n 1 "$service_history" 2>/dev/null || true)
  last_restart=${last_restart:-0}

  if [ "$last_restart" -gt 0 ] && [ $((now - last_restart)) -lt "$COOLDOWN_SECONDS" ]; then
    log_event warn "$service" cooldown_active
    continue
  fi
  if [ "$service_count" -ge "$MAX_SERVICE_RESTARTS" ] || [ "$global_count" -ge "$MAX_GLOBAL_RESTARTS" ]; then
    log_event error "$service" restart_circuit_open
    failed=1
    continue
  fi

  printf '%s\n' "$now" >>"$service_history"
  printf '%s\n' "$now" >>"$global_history"
  actions=$((actions + 1))
  rm -f "$STATE_DIR/$service.pending"
  log_event warn "$service" restart_started

  if ! "$COMPOSE" restart --no-deps --timeout 30 "$service"; then
    log_event error "$service" restart_command_failed
    failed=1
    continue
  fi
  if wait_for_health "$service"; then
    log_event info "$service" restart_recovered
  else
    log_event error "$service" restart_did_not_recover
    failed=1
  fi
done

if [ "$failed" -ne 0 ]; then
  exit "$failed"
fi

# Readiness consumes this marker rather than trusting the timer's active state:
# a systemd timer remains active even when every service invocation fails. Keep
# the previous successful marker intact until a complete scan succeeds, then
# replace it atomically on the same filesystem.
success_marker="$STATE_DIR/health-recovery-success"
success_tmp=$(mktemp "$STATE_DIR/.health-recovery-success.XXXXXX")
trap 'rm -f "$success_tmp"' EXIT HUP INT TERM
printf 'completed_at=%s\n' "$(date +%s)" >"$success_tmp"
chmod 600 "$success_tmp"
mv "$success_tmp" "$success_marker"
trap - EXIT HUP INT TERM

exit 0
