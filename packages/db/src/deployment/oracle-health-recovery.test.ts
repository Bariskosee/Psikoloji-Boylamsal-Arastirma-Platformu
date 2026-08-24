import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(__dirname, "..", "..", "..", "..");
const RECOVERY = resolve(ROOT, "infrastructure", "oracle", "recover-unhealthy.sh");
const COMPOSE_FILE = resolve(ROOT, "infrastructure", "oracle", "docker-compose.production.yml");
const INSTALL_SYSTEMD = resolve(ROOT, "infrastructure", "oracle", "install-systemd.sh");
const PARTICIPANT_READINESS = resolve(ROOT, "infrastructure", "oracle", "participant-readiness.sh");
const HEALTH_SERVICE = resolve(
  ROOT,
  "infrastructure",
  "oracle",
  "systemd",
  "lpr-health-recovery.service.in",
);
const HEALTH_TIMER = resolve(
  ROOT,
  "infrastructure",
  "oracle",
  "systemd",
  "lpr-health-recovery.timer",
);

const temporaryRoots: string[] = [];

interface Fixture {
  bin: string;
  operationState: string;
  recoveryState: string;
  root: string;
  script: string;
  serviceState: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(resolve(tmpdir(), "lpr-oracle-recovery-"));
  temporaryRoots.push(root);
  const oracle = resolve(root, "infrastructure", "oracle");
  const bin = resolve(root, "test-bin");
  const recoveryState = resolve(root, "recovery-state");
  const operationState = resolve(root, "operation-state");
  const serviceState = resolve(root, "service-state");
  mkdirSync(oracle, { recursive: true });
  mkdirSync(bin);
  copyFileSync(RECOVERY, resolve(oracle, "recover-unhealthy.sh"));
  chmodSync(resolve(oracle, "recover-unhealthy.sh"), 0o700);

  writeFileSync(
    resolve(oracle, "compose.sh"),
    `#!/bin/sh
set -eu
case "\${1:-}" in
  ps)
    case "\${3:-}" in
      postgres) printf '%s\\n' postgres-id ;;
      worker) printf '%s\\n' worker-id ;;
    esac
    ;;
  restart)
    service=\${5:-}
    printf '%s\\n' "$service" >>"$FAKE_RESTART_LOG"
    [ "\${FAKE_RESTART_FAIL:-0}" != 1 ] || exit 1
    printf '%s\\n' healthy >"$FAKE_SERVICE_STATE"
    ;;
  *) exit 64 ;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(
    resolve(bin, "docker"),
    `#!/bin/sh
set -eu
[ "\${1:-}" = inspect ] || exit 64
format=\${3:-}
container=\${4:-}
case "$format" in
  *State.Running*) printf '%s\\n' true ;;
  *State.Health*)
    if [ "$container" = postgres-id ]; then
      printf '%s\\n' "\${FAKE_POSTGRES_HEALTH:-healthy}"
    elif [ -f "$FAKE_SERVICE_STATE" ]; then
      sed -n '1p' "$FAKE_SERVICE_STATE"
    else
      printf '%s\\n' unhealthy
    fi
    ;;
  *Config.Labels*)
    if [ "$container" = postgres-id ]; then
      printf '%s\\n' 'lpr-oracle postgres'
    else
      printf '%s\\n' "$FAKE_WORKER_LABEL"
    fi
    ;;
  *) exit 65 ;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(resolve(bin, "flock"), '#!/bin/sh\n[ "${FAKE_FLOCK_FAIL:-0}" != 1 ]\n', {
    mode: 0o700,
  });

  return {
    bin,
    operationState,
    recoveryState,
    root,
    script: resolve(oracle, "recover-unhealthy.sh"),
    serviceState,
  };
}

function runRecovery(testFixture: Fixture, extraEnvironment: Record<string, string> = {}) {
  return spawnSync("sh", [testFixture.script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${testFixture.bin}:${process.env.PATH ?? ""}`,
      FAKE_RESTART_LOG: resolve(testFixture.root, "restarts.log"),
      FAKE_SERVICE_STATE: testFixture.serviceState,
      FAKE_WORKER_LABEL: "lpr-oracle worker",
      RECOVERY_STATE_DIR: testFixture.recoveryState,
      LPR_OPERATION_STATE_DIR: testFixture.operationState,
      RECOVERY_SAMPLE_MIN_SECONDS: "0",
      RECOVERY_SAMPLE_MAX_SECONDS: "300",
      RECOVERY_WAIT_SECONDS: "0",
      ...extraEnvironment,
    },
  });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Oracle unhealthy-service recovery", () => {
  it("requires two unhealthy samples and restarts only the matching service", () => {
    const testFixture = fixture();

    const first = runRecovery(testFixture);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("service=worker event=unhealthy_sample_1");
    expect(() => readFileSync(resolve(testFixture.root, "restarts.log"), "utf8")).toThrow();
    const successMarker = resolve(testFixture.recoveryState, "health-recovery-success");
    expect(readFileSync(successMarker, "utf8")).toMatch(/^completed_at=\d+\n$/);
    expect(statSync(successMarker).mode & 0o777).toBe(0o600);

    const second = runRecovery(testFixture);
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("service=worker event=restart_started");
    expect(second.stdout).toContain("service=worker event=restart_recovered");
    expect(readFileSync(resolve(testFixture.root, "restarts.log"), "utf8")).toBe("worker\n");
  });

  it("suppresses worker restart while PostgreSQL is unhealthy", () => {
    const testFixture = fixture();
    const environment = { FAKE_POSTGRES_HEALTH: "unhealthy" };

    const first = runRecovery(testFixture, environment);
    expect(first.status, first.stderr).toBe(0);
    const second = runRecovery(testFixture, environment);

    expect(second.status).toBe(1);
    expect(second.stdout).toContain(
      "service=postgres event=unhealthy_manual_intervention_required",
    );
    expect(second.stdout).toContain("service=worker event=restart_suppressed_by_postgres");
    expect(() => readFileSync(resolve(testFixture.root, "restarts.log"), "utf8")).toThrow();
  });

  it("fails closed when the container does not have the expected Compose identity", () => {
    const testFixture = fixture();
    mkdirSync(testFixture.recoveryState, { recursive: true });
    const successMarker = resolve(testFixture.recoveryState, "health-recovery-success");
    writeFileSync(successMarker, "completed_at=1\n", { mode: 0o600 });
    const result = runRecovery(testFixture, { FAKE_WORKER_LABEL: "other-project worker" });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("service=worker event=compose_identity_mismatch");
    expect(() => readFileSync(resolve(testFixture.root, "restarts.log"), "utf8")).toThrow();
    expect(readFileSync(successMarker, "utf8")).toBe("completed_at=1\n");
  });

  it("fails closed on corrupt persisted recovery state", () => {
    const testFixture = fixture();
    mkdirSync(testFixture.recoveryState, { recursive: true });
    writeFileSync(resolve(testFixture.recoveryState, "worker.pending"), "not-a-timestamp\n");

    const result = runRecovery(testFixture);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("service=worker event=pending_state_corrupt");
    expect(() => readFileSync(resolve(testFixture.root, "restarts.log"), "utf8")).toThrow();
  });

  it("opens the restart circuit after the configured attempt limit", () => {
    const testFixture = fixture();
    const environment = {
      FAKE_RESTART_FAIL: "1",
      RECOVERY_COOLDOWN_SECONDS: "0",
      RECOVERY_MAX_SERVICE_RESTARTS: "1",
    };

    expect(runRecovery(testFixture, environment).status).toBe(0);
    const failedRestart = runRecovery(testFixture, environment);
    expect(failedRestart.status).toBe(1);
    expect(failedRestart.stdout).toContain("service=worker event=restart_command_failed");

    expect(runRecovery(testFixture, environment).status).toBe(0);
    const openCircuit = runRecovery(testFixture, environment);
    expect(openCircuit.status).toBe(1);
    expect(openCircuit.stdout).toContain("service=worker event=restart_circuit_open");
    expect(readFileSync(resolve(testFixture.root, "restarts.log"), "utf8")).toBe("worker\n");
  });

  it("skips recovery while another deployment operation holds the shared lock", () => {
    const testFixture = fixture();
    const result = runRecovery(testFixture, { FAKE_FLOCK_FAIL: "1" });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("another deployment operation is active");
    expect(() => readFileSync(resolve(testFixture.root, "restarts.log"), "utf8")).toThrow();
    expect(() =>
      readFileSync(resolve(testFixture.recoveryState, "health-recovery-success"), "utf8"),
    ).toThrow();
  });
});

describe("Oracle health-recovery wiring", () => {
  it("keeps public services off the internal database network", () => {
    const compose = parse(readFileSync(COMPOSE_FILE, "utf8")) as {
      networks: Record<string, { internal?: boolean }>;
      services: Record<string, { healthcheck?: { test?: string[] }; networks?: string[] }>;
    };

    expect(compose.networks.data?.internal).toBe(true);
    expect(compose.services.postgres?.networks).toEqual(["data"]);
    expect(compose.services.api?.networks).toEqual(["web", "data"]);
    expect(compose.services.worker?.networks).toEqual(["web", "data"]);
    for (const service of ["participant", "researcher", "proxy"]) {
      expect(compose.services[service]?.networks).toEqual(["web"]);
    }
    expect(compose.services.proxy?.healthcheck?.test).toEqual([
      "CMD",
      "wget",
      "-q",
      "-O",
      "/dev/null",
      "http://127.0.0.1:2019/config/",
    ]);
  });

  it("installs a bounded user-level timer rather than a Docker-socket sidecar", () => {
    const recovery = readFileSync(RECOVERY, "utf8");
    const installer = readFileSync(INSTALL_SYSTEMD, "utf8");
    const readiness = readFileSync(PARTICIPANT_READINESS, "utf8");
    const service = readFileSync(HEALTH_SERVICE, "utf8");
    const timer = readFileSync(HEALTH_TIMER, "utf8");

    expect(recovery).toContain("flock -n 9");
    expect(recovery).toContain("MAX_SERVICE_RESTARTS=${RECOVERY_MAX_SERVICE_RESTARTS:-3}");
    expect(recovery).toContain("MAX_GLOBAL_RESTARTS=${RECOVERY_MAX_GLOBAL_RESTARTS:-5}");
    expect(recovery).toContain('if [ "$service" = "postgres" ]');
    expect(recovery).toContain(
      'success_tmp=$(mktemp "$STATE_DIR/.health-recovery-success.XXXXXX")',
    );
    expect(recovery).toContain('mv "$success_tmp" "$success_marker"');
    expect(installer).toContain("systemctl --user enable --now lpr-health-recovery.timer");
    expect(installer).toContain('loginctl show-user "$(id -u)" --property=Linger --value');
    expect(readiness).toContain("MAX_RECOVERY_SUCCESS_AGE_SECONDS:-300");
    expect(readiness).toContain('[ "$linger" = "yes" ]');
    expect(readiness).toContain('watchdog_marker="$RECOVERY_STATE_DIR/health-recovery-success"');
    expect(readiness).toContain('assert_fresh_epoch "health recovery watchdog"');
    expect(service).toContain("NoNewPrivileges=true");
    expect(service).toContain("TimeoutStartSec=6min");
    expect(timer).toContain("OnUnitActiveSec=60s");
  });
});
