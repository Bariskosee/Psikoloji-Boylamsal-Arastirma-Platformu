import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
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

const ROOT = resolve(__dirname, "..", "..", "..", "..");
const RESTIC_WRAPPER = resolve(ROOT, "infrastructure", "oracle", "restic-command.py");
const OFFSITE_BACKUP = resolve(ROOT, "infrastructure", "oracle", "offsite-backup.sh");
const RESTORE_DRILL = resolve(ROOT, "infrastructure", "oracle", "restore-offsite-drill.sh");
const SNAPSHOT_ID = "a".repeat(64);
const OLDER_SNAPSHOT_ID = "b".repeat(64);
const STAMP = "20260824T120000Z";
const REPOSITORY_LIMIT = 104_857_600;
const temporaryRoots: string[] = [];

interface Fixture {
  artifacts: string;
  bin: string;
  config: string;
  dockerLog: string;
  home: string;
  resticLog: string;
  root: string;
  state: string;
}

function privateWrite(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o600);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function fixture(): Fixture {
  const root = mkdtempSync(resolve(tmpdir(), "lpr-oracle-backup-"));
  temporaryRoots.push(root);
  const artifacts = resolve(root, "backups");
  const bin = resolve(root, "bin");
  const config = resolve(root, "restic-config");
  const home = resolve(root, "home");
  const state = resolve(root, "state");
  for (const directory of [artifacts, bin, config, home]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }

  const repository = resolve(config, "repository");
  privateWrite(repository, "s3:https://objects.example.test/lpr\n");
  privateWrite(resolve(config, "password"), "a-long-test-restic-password\n");
  privateWrite(
    resolve(config, "cost-residency-approval"),
    [
      "OFF_VM=yes",
      "ZERO_RECURRING_COST_CONFIRMED=yes",
      "NO_BILLABLE_OVERAGE_ENFORCED=yes",
      "DATA_RESIDENCY_APPROVED=yes",
      "STABLE_ORIGIN_CONFIRMED=yes",
      "DESTINATION=test-bucket-eu",
      `REPOSITORY_SHA256=${sha256(repository)}`,
      `MAX_REPOSITORY_BYTES=${REPOSITORY_LIMIT}`,
      "APPROVED_AT=2026-08-24",
      "",
    ].join("\n"),
  );

  const roles = resolve(artifacts, `roles-${STAMP}.sql`);
  const data = resolve(artifacts, `lpr-${STAMP}.dump`);
  const environment = resolve(artifacts, `environment-${STAMP}.production`);
  const manifest = resolve(artifacts, `manifest-${STAMP}.sha256`);
  privateWrite(roles, "CREATE ROLE lpr_app;\n");
  privateWrite(data, "fake-custom-format-database-dump\n");
  privateWrite(environment, "APP_DATABASE_USER=lpr_app\n");
  privateWrite(
    manifest,
    [
      `${sha256(roles)}  roles-${STAMP}.sql`,
      `${sha256(data)}  lpr-${STAMP}.dump`,
      `${sha256(environment)}  environment-${STAMP}.production`,
      "",
    ].join("\n"),
  );

  const resticLog = resolve(root, "restic.log");
  writeFileSync(
    resolve(bin, "restic"),
    `#!/bin/sh
if [ -n "\${FAKE_RESTIC_LOG:-}" ]; then
  printf '%s\\n' "$*" >>"$FAKE_RESTIC_LOG"
fi
case "$1" in
  probe) printf '%s\\n' "\${AWS_SECRET_ACCESS_KEY:-}" ;;
  cat|check) ;;
  stats) printf '{"total_size":%s}\\n' "\${FAKE_REPOSITORY_BYTES:-1024}" ;;
  backup) printf '{"message_type":"summary","snapshot_id":"%s"}\\n' "$FAKE_SNAPSHOT_ID" ;;
  snapshots)
    if [ "\${FAKE_SNAPSHOT_MISSING:-0}" = 1 ]; then
      printf '[]\\n'
    else
      printf '[{"id":"%s","hostname":"lpr-oracle-prod","tags":["lpr-nightly","lpr-20260823T120000Z"],"time":"2026-08-23T12:00:00Z"},{"id":"%s","hostname":"lpr-oracle-prod","tags":["lpr-nightly","lpr-%s"],"time":"2026-08-24T12:00:00Z"}]\\n' "$FAKE_OLDER_SNAPSHOT_ID" "$FAKE_SNAPSHOT_ID" "$FAKE_STAMP"
    fi
    ;;
  restore)
    shift
    target=
    while [ "$#" -gt 0 ]; do
      if [ "$1" = --target ]; then shift; target=$1; fi
      shift
    done
    [ -n "$target" ] || exit 2
    /bin/mkdir -p "$target/snapshot"
    /bin/cp "$FAKE_ARTIFACT_DIR/roles-$FAKE_STAMP.sql" "$target/snapshot/"
    /bin/cp "$FAKE_ARTIFACT_DIR/lpr-$FAKE_STAMP.dump" "$target/snapshot/"
    /bin/cp "$FAKE_ARTIFACT_DIR/environment-$FAKE_STAMP.production" "$target/snapshot/"
    /bin/cp "$FAKE_ARTIFACT_DIR/manifest-$FAKE_STAMP.sha256" "$target/snapshot/"
    ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(resolve(bin, "flock"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  writeFileSync(
    resolve(bin, "stat"),
    `#!/bin/sh
if [ "$1" = -c ]; then
  case "$2" in
    %u) exec /usr/bin/stat -f %u "$3" ;;
    %a) exec /usr/bin/stat -f %Lp "$3" ;;
  esac
fi
exec /usr/bin/stat "$@"
`,
    { mode: 0o700 },
  );

  const dockerLog = resolve(root, "docker.log");
  writeFileSync(
    resolve(bin, "docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$1" in
  run|cp|rm) exit 0 ;;
  exec)
    case "$*" in
      *identity.researcher_users*) exit 1 ;;
      *-F,*) printf '10,20,3,4,0,0,0,0\\nt\\n' ;;
      *) exit 0 ;;
    esac
    ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o700 },
  );

  return { artifacts, bin, config, dockerLog, home, resticLog, root, state };
}

function environment(testFixture: Fixture): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BACKUP_DIR: testFixture.artifacts,
    BACKUP_STATE_DIR: testFixture.state,
    FAKE_ARTIFACT_DIR: testFixture.artifacts,
    FAKE_DOCKER_LOG: testFixture.dockerLog,
    FAKE_RESTIC_LOG: testFixture.resticLog,
    FAKE_OLDER_SNAPSHOT_ID: OLDER_SNAPSHOT_ID,
    FAKE_SNAPSHOT_ID: SNAPSHOT_ID,
    FAKE_STAMP: STAMP,
    HOME: testFixture.home,
    LPR_RESTIC_CONFIG_DIR: testFixture.config,
    PATH: `${testFixture.bin}:${process.env.PATH ?? ""}`,
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the validated Restic command wrapper", () => {
  it("treats credentials as literal data and rejects executable environment controls", () => {
    const literal = fixture();
    privateWrite(
      resolve(literal.config, "backend.env"),
      "AWS_SECRET_ACCESS_KEY=$(echo not-executed)\n",
    );
    const literalResult = spawnSync("python3", [RESTIC_WRAPPER, "probe"], {
      encoding: "utf8",
      env: environment(literal),
    });
    expect(literalResult.status, literalResult.stderr).toBe(0);
    expect(literalResult.stdout.trim()).toBe("$(echo not-executed)");

    for (const control of [
      "PATH=/untrusted",
      "LD_PRELOAD=/untrusted.so",
      "PYTHONPATH=/untrusted",
    ]) {
      const unsafe = fixture();
      privateWrite(resolve(unsafe.config, "backend.env"), `${control}\n`);
      const result = spawnSync("python3", [RESTIC_WRAPPER, "probe"], {
        encoding: "utf8",
        env: environment(unsafe),
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("may influence executable code");
    }
  });

  it("rejects local repositories and command-line repository overrides", () => {
    const local = fixture();
    privateWrite(resolve(local.config, "repository"), `${resolve(local.root, "repository")}\n`);
    const localResult = spawnSync("python3", [RESTIC_WRAPPER, "snapshots", "--json"], {
      encoding: "utf8",
      env: environment(local),
    });
    expect(localResult.status).not.toBe(0);
    expect(localResult.stderr).toContain("recognized remote backend");

    const override = fixture();
    const overrideResult = spawnSync(
      "python3",
      [RESTIC_WRAPPER, "snapshots", "--repo", resolve(override.root, "repository")],
      { encoding: "utf8", env: environment(override) },
    );
    expect(overrideResult.status).not.toBe(0);
    expect(overrideResult.stderr).toContain("--repo is managed by this wrapper");
  });
});

describe("encrypted off-site backup evidence", () => {
  it("writes success evidence only after exact remote snapshot metadata is confirmed", () => {
    const testFixture = fixture();
    const result = spawnSync("sh", [OFFSITE_BACKUP, STAMP], {
      encoding: "utf8",
      env: environment(testFixture),
    });

    expect(result.status, result.stderr).toBe(0);
    const marker = readFileSync(resolve(testFixture.state, "offsite-success"), "utf8");
    expect(marker).toContain(`snapshot_id=${SNAPSHOT_ID}`);
    expect(marker).toContain(`max_repository_bytes=${REPOSITORY_LIMIT}`);
    expect(marker).toContain("repository_bytes=1024");
  });

  it("requires an enforced no-overage approval and refuses metadata or threshold failures", () => {
    const unapproved = fixture();
    const approval = resolve(unapproved.config, "cost-residency-approval");
    privateWrite(
      approval,
      readFileSync(approval, "utf8").replace(
        "NO_BILLABLE_OVERAGE_ENFORCED=yes",
        "NO_BILLABLE_OVERAGE_ENFORCED=no",
      ),
    );
    const unapprovedResult = spawnSync("sh", [OFFSITE_BACKUP, STAMP], {
      encoding: "utf8",
      env: environment(unapproved),
    });
    expect(unapprovedResult.status).not.toBe(0);
    expect(unapprovedResult.stderr).toContain("NO_BILLABLE_OVERAGE_ENFORCED");
    expect(existsSync(unapproved.resticLog)).toBe(false);

    const changedDestination = fixture();
    privateWrite(
      resolve(changedDestination.config, "repository"),
      "s3:https://objects.example.test/different-bucket\n",
    );
    const changedDestinationResult = spawnSync("sh", [OFFSITE_BACKUP, STAMP], {
      encoding: "utf8",
      env: environment(changedDestination),
    });
    expect(changedDestinationResult.status).not.toBe(0);
    expect(changedDestinationResult.stderr).toContain("REPOSITORY_SHA256");
    expect(existsSync(changedDestination.resticLog)).toBe(false);

    const missing = fixture();
    const missingResult = spawnSync("sh", [OFFSITE_BACKUP, STAMP], {
      encoding: "utf8",
      env: { ...environment(missing), FAKE_SNAPSHOT_MISSING: "1" },
    });
    expect(missingResult.status).not.toBe(0);
    expect(existsSync(resolve(missing.state, "offsite-success"))).toBe(false);

    const full = fixture();
    const fullResult = spawnSync("sh", [OFFSITE_BACKUP, STAMP], {
      encoding: "utf8",
      env: {
        ...environment(full),
        FAKE_REPOSITORY_BYTES: String(REPOSITORY_LIMIT - 33_554_432),
      },
    });
    expect(fullResult.status).not.toBe(0);
    expect(fullResult.stderr).toContain("conservative repository projection");
    expect(readFileSync(full.resticLog, "utf8")).not.toMatch(/^backup /m);
  }, 15_000);

  it("restores from the encrypted transaction without a live env file", () => {
    const testFixture = fixture();
    const backup = spawnSync("sh", [OFFSITE_BACKUP, STAMP], {
      encoding: "utf8",
      env: environment(testFixture),
    });
    expect(backup.status, backup.stderr).toBe(0);

    const drill = spawnSync("sh", [RESTORE_DRILL], {
      encoding: "utf8",
      env: { ...environment(testFixture), ENV_FILE: resolve(testFixture.root, "missing") },
    });
    expect(drill.status, drill.stderr).toBe(0);
    expect(readFileSync(resolve(testFixture.state, "restore-drill-success"), "utf8")).toContain(
      `snapshot_id=${SNAPSHOT_ID}`,
    );
    expect(readFileSync(testFixture.dockerLog, "utf8")).toContain(
      "run -d --pull=never --network none --memory=768m --cpus=1",
    );
  });

  it("recovers the newest authenticated nightly snapshot on a fresh VM", () => {
    const testFixture = fixture();
    const recoveryParent = resolve(testFixture.root, "private-recovery");
    const recoveryBundle = resolve(recoveryParent, "latest");
    mkdirSync(recoveryParent, { mode: 0o700 });
    chmodSync(recoveryParent, 0o700);

    const drill = spawnSync("sh", [RESTORE_DRILL, "--fresh-vm-recovery", recoveryBundle], {
      encoding: "utf8",
      env: environment(testFixture),
    });

    expect(drill.status, drill.stderr).toBe(0);
    expect(existsSync(resolve(testFixture.state, "offsite-success"))).toBe(false);
    expect(statSync(recoveryBundle).mode & 0o777).toBe(0o700);
    for (const name of [
      `roles-${STAMP}.sql`,
      `lpr-${STAMP}.dump`,
      `environment-${STAMP}.production`,
      `manifest-${STAMP}.sha256`,
      "recovery-evidence",
    ]) {
      expect(statSync(resolve(recoveryBundle, name)).mode & 0o777).toBe(0o600);
    }
    const evidence = readFileSync(resolve(recoveryBundle, "recovery-evidence"), "utf8");
    expect(evidence).toContain(`snapshot_id=${SNAPSHOT_ID}`);
    expect(evidence).toContain(`stamp=${STAMP}`);
    expect(evidence).toContain(
      `repository_sha256=${sha256(resolve(testFixture.config, "repository"))}`,
    );
    const resticLog = readFileSync(testFixture.resticLog, "utf8");
    expect(resticLog).toContain("snapshots --json --host lpr-oracle-prod --tag lpr-nightly");
    expect(resticLog).toMatch(new RegExp(`^restore ${SNAPSHOT_ID} --target `, "m"));
  });
});
