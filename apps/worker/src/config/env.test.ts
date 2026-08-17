import { describe, expect, it } from "vitest";
import { loadWorkerEnv } from "./env.js";

const MINIMAL = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

describe("loadWorkerEnv", () => {
  it("defaults the sweep interval to 60 seconds", () => {
    expect(loadWorkerEnv(MINIMAL as NodeJS.ProcessEnv).SWEEP_INTERVAL_SECONDS).toBe(60);
  });

  it("refuses to start without a database URL", () => {
    expect(() => loadWorkerEnv({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  // The sweep interval bounds scheduling recovery time after an outage
  // (ADR-005), so an unreasonable value must fail loudly rather than degrade
  // the guarantee quietly.
  it("rejects a sweep interval long enough to weaken the recovery guarantee", () => {
    expect(() =>
      loadWorkerEnv({ ...MINIMAL, SWEEP_INTERVAL_SECONDS: "3600" } as NodeJS.ProcessEnv),
    ).toThrow(/SWEEP_INTERVAL_SECONDS/);
  });

  it("rejects a sweep interval too short to be sane", () => {
    expect(() =>
      loadWorkerEnv({ ...MINIMAL, SWEEP_INTERVAL_SECONDS: "1" } as NodeJS.ProcessEnv),
    ).toThrow(/SWEEP_INTERVAL_SECONDS/);
  });
});
