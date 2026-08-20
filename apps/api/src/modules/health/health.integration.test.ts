import request from "supertest";
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
