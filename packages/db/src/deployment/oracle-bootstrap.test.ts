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

const ROOT = resolve(__dirname, "..", "..", "..", "..");
const BOOTSTRAP = resolve(ROOT, "infrastructure", "oracle", "bootstrap-env.sh");
const TEMPLATE = resolve(ROOT, "infrastructure", "oracle", ".env.production.example");
const CREATE_ADMIN = resolve(ROOT, "infrastructure", "oracle", "create-admin.sh");

const temporaryRoots: string[] = [];

interface Fixture {
  bin: string;
  root: string;
  script: string;
  target: string;
}

function fixture(): Fixture {
  const root = mkdtempSync(resolve(tmpdir(), "lpr-oracle-bootstrap-"));
  temporaryRoots.push(root);
  const oracle = resolve(root, "infrastructure", "oracle");
  const bin = resolve(root, "test-bin");
  mkdirSync(oracle, { recursive: true });
  mkdirSync(bin);
  copyFileSync(BOOTSTRAP, resolve(oracle, "bootstrap-env.sh"));
  copyFileSync(TEMPLATE, resolve(oracle, ".env.production.example"));
  writeFileSync(resolve(bin, "openssl"), "#!/bin/sh\nprintf '%096d\\n' 0\n", { mode: 0o700 });
  writeFileSync(
    resolve(bin, "docker"),
    '#!/bin/sh\nprintf \'%s\\n\' \'{"publicKey":"test-public","privateKey":"test-private"}\'\n',
    { mode: 0o700 },
  );
  const script = resolve(oracle, "bootstrap-env.sh");
  chmodSync(script, 0o700);
  return { bin, root, script, target: resolve(root, ".env.production") };
}

function runBootstrap(args: string[]) {
  const testFixture = fixture();
  const result = spawnSync("sh", [testFixture.script, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${testFixture.bin}:${process.env.PATH ?? ""}`,
    },
  });
  return { ...testFixture, result };
}

function values(contents: string): Record<string, string> {
  return Object.fromEntries(
    contents
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]),
  );
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Oracle production environment bootstrap", () => {
  it("derives stable participant origins from an explicit domain", () => {
    const { result, target } = runBootstrap([
      "--domain",
      "study.example.org",
      "--acme-email",
      "ops@example.org",
    ]);

    expect(result.status, result.stderr).toBe(0);
    const environment = values(readFileSync(target, "utf8"));
    expect(environment).toMatchObject({
      DEPLOYMENT_MODE: "participant",
      ORIGIN_MODE: "domain",
      API_HOST: "api.study.example.org",
      PARTICIPANT_HOST: "participant.study.example.org",
      RESEARCHER_HOST: "researcher.study.example.org",
      ACME_EMAIL: "ops@example.org",
      VAPID_SUBJECT: "https://participant.study.example.org",
    });
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("accepts three explicit stable hostnames", () => {
    const { result, target } = runBootstrap([
      "--hostnames",
      "api.example.org",
      "join.example.org",
      "dashboard.example.org",
      "--acme-email",
      "ops@example.org",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(values(readFileSync(target, "utf8"))).toMatchObject({
      DEPLOYMENT_MODE: "participant",
      ORIGIN_MODE: "domain",
      API_HOST: "api.example.org",
      PARTICIPANT_HOST: "join.example.org",
      RESEARCHER_HOST: "dashboard.example.org",
    });
  });

  it("records an explicitly asserted reserved IP as participant-safe metadata", () => {
    const { result, target } = runBootstrap([
      "--reserved-ip",
      "8.8.8.8",
      "--acme-email",
      "ops@example.org",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("asserts that this address is reserved and stable");
    expect(values(readFileSync(target, "utf8"))).toMatchObject({
      DEPLOYMENT_MODE: "participant",
      ORIGIN_MODE: "reserved-ip",
      API_HOST: "api.8-8-8-8.sslip.io",
      PARTICIPANT_HOST: "participant.8-8-8-8.sslip.io",
      RESEARCHER_HOST: "researcher.8-8-8-8.sslip.io",
    });
  });

  it("makes ephemeral-IP sslip.io origins unmistakably smoke-only", () => {
    const { result, target } = runBootstrap([
      "--smoke-test-ip",
      "1.1.1.1",
      "--acme-email",
      "ops@example.org",
    ]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("WARNING: SMOKE TEST ONLY");
    expect(result.stderr).toContain("DO NOT ENROLL REAL PARTICIPANTS");
    expect(result.stdout).toContain("SMOKE TEST mode");
    expect(values(readFileSync(target, "utf8"))).toMatchObject({
      DEPLOYMENT_MODE: "smoke",
      ORIGIN_MODE: "ephemeral-ip",
      PARTICIPANT_HOST: "participant.1-1-1-1.sslip.io",
    });
  });

  it("rejects the legacy bare-IP invocation and sslip.io disguised as stable DNS", () => {
    const legacy = runBootstrap(["1.1.1.1"]);
    expect(legacy.result.status).toBe(2);
    expect(legacy.result.stderr).toContain("--smoke-test-ip");

    const disguised = runBootstrap([
      "--hostnames",
      "api.1-1-1-1.sslip.io",
      "participant.1-1-1-1.sslip.io",
      "researcher.1-1-1-1.sslip.io",
      "--acme-email",
      "ops@example.org",
    ]);
    expect(disguised.result.status).toBe(2);
    expect(disguised.result.stderr).toContain("uses sslip.io");
  });
});

describe("Oracle administrator bootstrap", () => {
  it("requires an explicit nonempty display name", () => {
    const missing = spawnSync("sh", [CREATE_ADMIN, "admin@example.org"], { encoding: "utf8" });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("<email> <display-name>");

    const empty = spawnSync("sh", [CREATE_ADMIN, "admin@example.org", ""], {
      encoding: "utf8",
    });
    expect(empty.status).toBe(2);
    expect(empty.stderr).toContain("display-name cannot be empty");
  });
});
