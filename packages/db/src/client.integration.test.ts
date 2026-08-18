import { afterAll, describe, expect, it } from "vitest";
import { createPool, ping } from "./client.js";

/**
 * Integration tests — these need a REAL PostgreSQL.
 *
 * They exist from Phase 0 partly to prove the connectivity helpers behave
 * against a live server, and partly so the CI integration lane is a genuine
 * signal rather than a step that passes while running nothing. Phase 1 adds
 * migration and constraint tests to this lane.
 *
 * Run with: pnpm --filter=@lpr/db test:integration
 */
/**
 * No default. A hardcoded fallback here would silently connect somewhere other
 * than the environment under test — which is exactly how this suite once passed
 * locally (matching the developer's Docker) while failing in CI. An integration
 * test that cannot see its target must fail loudly, not improvise one.
 */
const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is required for integration tests.\n" +
      "  Local:  pnpm db:up && cp .env.example .env\n" +
      "  CI:     provide it in the job environment\n" +
      "Note: turbo.json must also declare DATABASE_URL under the task's `env`, " +
      "or Turborepo strips it before the test process starts.",
  );
}

const pool = createPool({ connectionString, max: 2 });

afterAll(async () => {
  await pool.end();
});

describe("ping against a live database", () => {
  it("reports ok with a measured latency", async () => {
    const result = await ping(pool);

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.latencyMs).toBeLessThan(5_000);
  });

  it("is safe to call repeatedly on the same pool", async () => {
    const results = await Promise.all([ping(pool), ping(pool), ping(pool)]);
    expect(results.every((r) => r.ok)).toBe(true);
  });
});

describe("ping against an unreachable database", () => {
  it("fails closed with a non-empty reason rather than throwing", async () => {
    const deadPool = createPool({
      // Port 1 is reserved and never listening.
      connectionString: "postgresql://nobody:nothing@127.0.0.1:1/nope",
      connectionTimeoutMillis: 2_000,
      onError: () => {
        /* expected; must not crash the process */
      },
    });

    const result = await ping(deadPool);

    expect(result.ok).toBe(false);
    // A readiness failure with no stated reason is useless during an outage.
    expect(result.error).toBeTruthy();
    expect(result.error).not.toBe("");

    await deadPool.end();
  });
});

describe("pool resilience", () => {
  it("survives an idle-client error instead of crashing the process", async () => {
    // pg.Pool emits 'error' for dead idle clients. Node treats an unhandled
    // 'error' event as fatal, which would take down the API and the worker on
    // any transient database blip. createPool must always attach a handler.
    let observed: Error | undefined;
    const p = createPool({ connectionString, onError: (e) => (observed = e) });

    await ping(p);
    p.emit("error", new Error("simulated idle client failure"));

    expect(observed?.message).toBe("simulated idle client failure");
    await p.end();
  });
});
