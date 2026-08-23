import request from "supertest";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../testing/harness.js";

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

/**
 * The probes must answer WITHOUT a session.
 *
 * Authentication is global and opt-out, and health predates it, so the two
 * `@Public()` decorators are easy to lose in a refactor and impossible to miss
 * in production: a probe reads the resulting 401 as "never ready" and the
 * service is quietly withheld from the load balancer while it serves perfectly.
 * Nothing else in the suite exercises an unauthenticated route except login.
 */
describe("health probes", () => {
  it("serves GET /health to an unauthenticated caller", async () => {
    const response = await request(harness.app.getHttpServer()).get("/health").expect(200);

    expect(response.body.status).toBeDefined();
  });

  it("serves GET /ready to an unauthenticated caller", async () => {
    const response = await request(harness.app.getHttpServer()).get("/ready");

    // 200 with the database up, 503 without it — never 401, which is the
    // regression this test exists to catch.
    expect([200, 503]).toContain(response.status);
    expect(response.body.ready).toBe(response.status === 200);
  });

  it("does not require a session cookie for either probe", async () => {
    for (const path of ["/health", "/ready"]) {
      const response = await request(harness.app.getHttpServer()).get(path);
      expect(response.status).not.toBe(401);
    }
  });
});

/**
 * Readiness covers the job system too (PLAN.md Phase 12).
 *
 * ── The failure this exists to catch ────────────────────────────────────────
 * The API is a pg-boss CLIENT: the worker owns the `pgboss` schema and installs
 * it (ADR-004). Bring the API up first, or against a database the worker has
 * never touched, and every enqueue fails — while the probe cheerfully reports
 * ready. Notifications then go missing with nothing anywhere saying why.
 *
 * ── And the failure this exists to PREVENT ──────────────────────────────────
 * The opposite over-correction. A missing queue must NOT drain traffic from the
 * API: participants can still open sessions and save answers, and ADR-005 makes
 * the sweepers — not the queue — the thing that keeps the schedule correct. An
 * API withheld from the load balancer because the worker is slow to boot turns
 * "reminders are late" into "the study is down".
 *
 * So the check is visible and non-fatal, and the second test below is the one
 * that would fail if somebody later "fixed" it into the readiness verdict.
 */
describe("readiness — the job system", () => {
  const dropSchema = () => harness.db.execute(sql`DROP SCHEMA IF EXISTS pgboss CASCADE`);

  it("reports the job system as a named check", async () => {
    const response = await request(harness.app.getHttpServer()).get("/ready");
    const names = (response.body.checks as { name: string }[]).map((check) => check.name);

    expect(names).toContain("postgres");
    expect(names).toContain("jobs");
  });

  it("fails the jobs check, and stays ready, when the queue schema is absent", async () => {
    await dropSchema();

    const response = await request(harness.app.getHttpServer()).get("/ready").expect(200);
    const jobs = (response.body.checks as { name: string; ok: boolean; error?: string }[]).find(
      (check) => check.name === "jobs",
    );

    expect(jobs?.ok).toBe(false);
    // The error names the cause and who fixes it, because the person reading a
    // probe at 3am has no other context.
    expect(jobs?.error).toContain("worker");
    // The verdict itself is unchanged. This assertion is the point of the test.
    expect(response.body.ready).toBe(true);
  });

  it("passes the jobs check once the queue schema exists", async () => {
    await harness.db.execute(sql`CREATE SCHEMA IF NOT EXISTS pgboss`);

    const response = await request(harness.app.getHttpServer()).get("/ready").expect(200);
    const jobs = (response.body.checks as { name: string; ok: boolean }[]).find(
      (check) => check.name === "jobs",
    );

    expect(jobs?.ok).toBe(true);

    // Left as we found it: the worker suite in this repository installs the real
    // schema, and a bare `pgboss` with no tables would be a confusing thing to
    // leave behind in a shared database.
    await dropSchema();
  });
});
