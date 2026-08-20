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

  /**
   * The heartbeat is keyed on this. An id that changes per start leaves a trail
   * of orphaned, permanently-stale rows; an id shared between replicas makes
   * them overwrite each other, so either going down becomes invisible
   * (ADR-005).
   */
  it("leaves the worker id unset so the caller can fall back to the hostname", () => {
    expect(loadWorkerEnv(MINIMAL as NodeJS.ProcessEnv).WORKER_ID).toBeUndefined();
  });

  it("accepts an explicit worker id", () => {
    expect(
      loadWorkerEnv({ ...MINIMAL, WORKER_ID: "worker-eu-1" } as NodeJS.ProcessEnv).WORKER_ID,
    ).toBe("worker-eu-1");
  });

  it("rejects an empty worker id rather than writing a nameless heartbeat", () => {
    expect(() => loadWorkerEnv({ ...MINIMAL, WORKER_ID: "" } as NodeJS.ProcessEnv)).toThrow(
      /WORKER_ID/,
    );
  });
});
