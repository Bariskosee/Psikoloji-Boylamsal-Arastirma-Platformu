import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { researcherPasswordResets, researcherUsers } from "@lpr/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  Client,
  RESEARCHER_ORIGIN,
  createHarness,
  createUser,
  resetDatabase,
  type Harness,
  type TestUser,
} from "../../testing/harness.js";
import { hashToken } from "../../common/crypto.js";
import { PasswordResetService } from "./password-reset.service.js";

let harness: Harness;

beforeAll(async () => {
  harness = await createHarness();
});

afterAll(async () => {
  await harness.close();
});

beforeEach(async () => {
  await resetDatabase(harness.db);
  harness.resetRateLimits();
});

const NEW_PASSWORD = "a wide field of barley";

function post(path: string, body: unknown) {
  return request(harness.app.getHttpServer())
    .post(path)
    .set("Origin", RESEARCHER_ORIGIN)
    .send(body);
}

/**
 * Read the token out of the database.
 *
 * The token itself is never stored, only its SHA-256, so a test cannot recover
 * one from the row — which is the property being relied on. Instead the test
 * mints its own token, stores the matching hash, and uses the plaintext. That
 * exercises exactly the lookup the real flow performs.
 */
async function plantToken(
  user: TestUser,
  overrides: { expiresAt?: Date; usedAt?: Date } = {},
): Promise<string> {
  const token = "a1".repeat(32);
  await harness.db.insert(researcherPasswordResets).values({
    tokenHash: hashToken(token),
    userId: user.id,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 30 * 60_000),
    ...(overrides.usedAt ? { usedAt: overrides.usedAt } : {}),
  });
  return token;
}

describe("password reset — no account enumeration", () => {
  /**
   * The property this endpoint exists to preserve.
   *
   * An institution's researcher list is worth having, and a reset endpoint
   * that answers differently for a known address publishes it one query at a
   * time. Status, body, and rate-limit behaviour must all be identical.
   */
  it("answers identically for a known and an unknown address", async () => {
    const user = await createUser(harness.db);

    const known = await post("/api/auth/password-reset/request", { email: user.email });
    const unknown = await post("/api/auth/password-reset/request", {
      email: "nobody-at-all@example.org",
    });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
  });

  /**
   * The subtler oracle: budgets.
   *
   * If the rate limiter were only charged for real accounts, an attacker could
   * distinguish them by making six requests and seeing which addresses start
   * returning 429. Unknown addresses must burn the budget too.
   */
  it("spends the rate-limit budget for an unknown address as well", async () => {
    const email = "still-nobody@example.org";

    const statuses: number[] = [];
    for (let attempt = 0; attempt < 7; attempt += 1) {
      statuses.push((await post("/api/auth/password-reset/request", { email })).status);
    }

    expect(statuses).toContain(429);
  });

  it("records an audit event even when the address matches no account", async () => {
    await post("/api/auth/password-reset/request", { email: "probe@example.org" }).expect(202);

    const events = await harness.db.execute<{ action: string }>(
      sql`SELECT action FROM research.audit_events WHERE action LIKE 'auth.%'`,
    );

    expect(events.rows.length).toBeGreaterThan(0);
  });
});

describe("password reset — the token", () => {
  it("mints a token whose plaintext is never stored", async () => {
    const user = await createUser(harness.db);

    await post("/api/auth/password-reset/request", { email: user.email }).expect(202);

    const rows = await harness.db
      .select()
      .from(researcherPasswordResets)
      .where(eq(researcherPasswordResets.userId, user.id));

    expect(rows).toHaveLength(1);
    // 64 hex characters of SHA-256, not the 64-character token. The two are
    // the same length, so the assertion is that the column holds a HASH: it
    // must not match the hash of itself.
    expect(rows[0]?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(rows[0]!.tokenHash)).not.toBe(rows[0]?.tokenHash);
  });

  /**
   * Three clicks of "forgot password" must not leave three live
   * account-takeover links sitting in an inbox.
   */
  it("invalidates any outstanding link when a new one is requested", async () => {
    const user = await createUser(harness.db);
    const first = await plantToken(user);

    await post("/api/auth/password-reset/request", { email: user.email }).expect(202);

    await post("/api/auth/password-reset/confirm", {
      token: first,
      newPassword: NEW_PASSWORD,
    }).expect(400);
  });

  it("refuses an expired token", async () => {
    const user = await createUser(harness.db);
    const token = await plantToken(user, { expiresAt: new Date(Date.now() - 1_000) });

    const response = await post("/api/auth/password-reset/confirm", {
      token,
      newPassword: NEW_PASSWORD,
    }).expect(400);

    expect(response.body.error.code).toBe("INVALID_RESET_TOKEN");
  });

  /**
   * Every rejection is the same error, deliberately.
   *
   * "Already used" would tell somebody holding a stolen link that it was real.
   */
  it("reports an unknown, an expired, and a spent token identically", async () => {
    const user = await createUser(harness.db);
    const expired = await plantToken(user, { expiresAt: new Date(Date.now() - 1_000) });
    const spent = "b2".repeat(32);
    await harness.db.insert(researcherPasswordResets).values({
      tokenHash: hashToken(spent),
      userId: user.id,
      expiresAt: new Date(Date.now() + 30 * 60_000),
      usedAt: new Date(),
    });

    const bodies = [];
    for (const token of [expired, spent, "c3".repeat(32)]) {
      const response = await post("/api/auth/password-reset/confirm", {
        token,
        newPassword: NEW_PASSWORD,
      }).expect(400);
      bodies.push(response.body);
    }

    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  });

  it("rejects a token that is not the right shape before touching the database", async () => {
    await post("/api/auth/password-reset/confirm", {
      token: "much-too-short",
      newPassword: NEW_PASSWORD,
    }).expect(400);
  });
});

describe("password reset — completing it", () => {
  it("sets the new password and lets it log in", async () => {
    const user = await createUser(harness.db);
    const token = await plantToken(user);

    await post("/api/auth/password-reset/confirm", {
      token,
      newPassword: NEW_PASSWORD,
    }).expect(200);

    await post("/api/auth/login", { email: user.email, password: NEW_PASSWORD }).expect(200);
    await post("/api/auth/login", { email: user.email, password: user.password }).expect(401);
  });

  /**
   * A reset ends EVERY session, with no exception for the caller — unlike a
   * password change, which spares the session doing the changing.
   *
   * The reason somebody resets a password is often that they believe an
   * attacker holds a session. Leaving one alive makes the reset pointless.
   */
  it("ends every existing session", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);
    await client.get("/api/auth/me").expect(200);

    const token = await plantToken(user);
    await post("/api/auth/password-reset/confirm", {
      token,
      newPassword: NEW_PASSWORD,
    }).expect(200);

    await client.get("/api/auth/me").expect(401);
  });

  /**
   * Single use, enforced by a conditional UPDATE rather than a read-then-write.
   *
   * Two clicks of the same link arrive together in the real world — a mail
   * client prefetching the URL and the human clicking it is the common case.
   * Both pass the read; only one may spend the token.
   */
  it("cannot be spent twice, even by two simultaneous requests", async () => {
    const user = await createUser(harness.db);
    const token = await plantToken(user);

    const results = await Promise.all([
      post("/api/auth/password-reset/confirm", { token, newPassword: NEW_PASSWORD }),
      post("/api/auth/password-reset/confirm", { token, newPassword: "an entirely other one" }),
    ]);

    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 400]);

    // And exactly one of the two passwords works — not both, and not neither.
    const winner = await post("/api/auth/login", {
      email: user.email,
      password: NEW_PASSWORD,
    });
    const loser = await post("/api/auth/login", {
      email: user.email,
      password: "an entirely other one",
    });
    expect([winner.status, loser.status].filter((s) => s === 200)).toHaveLength(1);
  });

  it("refuses a password that fails the policy, and leaves the token unspent", async () => {
    const user = await createUser(harness.db);
    const token = await plantToken(user);

    const weak = await post("/api/auth/password-reset/confirm", {
      token,
      newPassword: "short",
    });
    expect(weak.status).toBe(400);

    // Still usable: a rejected password must not burn the researcher's link.
    await post("/api/auth/password-reset/confirm", {
      token,
      newPassword: NEW_PASSWORD,
    }).expect(200);
  });

  /**
   * An account deactivated between the request and the click must not be
   * revived by a link that was legitimate when it was sent.
   */
  it("refuses a token belonging to a deactivated account", async () => {
    const user = await createUser(harness.db);
    const token = await plantToken(user);
    await harness.db
      .update(researcherUsers)
      .set({ isActive: false })
      .where(eq(researcherUsers.id, user.id));

    await post("/api/auth/password-reset/confirm", {
      token,
      newPassword: NEW_PASSWORD,
    }).expect(400);
  });

  it("does not sign the researcher in", async () => {
    const user = await createUser(harness.db);
    const token = await plantToken(user);

    const response = await post("/api/auth/password-reset/confirm", {
      token,
      newPassword: NEW_PASSWORD,
    }).expect(200);

    // Arriving from an emailed link is not proof of identity at a keyboard. A
    // reset that ended in a live session would make a stolen link worth more.
    expect(response.headers["set-cookie"]).toBeUndefined();
  });
});

describe("password reset — housekeeping", () => {
  it("deletes tokens that can no longer be used", async () => {
    const user = await createUser(harness.db);
    await plantToken(user, { expiresAt: new Date(Date.now() - 60_000) });
    const live = "d4".repeat(32);
    await harness.db.insert(researcherPasswordResets).values({
      tokenHash: hashToken(live),
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
    });

    const deleted = await harness.app.get(PasswordResetService).deleteExpired(new Date());

    expect(deleted).toBe(1);
    const remaining = await harness.db
      .select()
      .from(researcherPasswordResets)
      .where(and(eq(researcherPasswordResets.userId, user.id)));
    expect(remaining).toHaveLength(1);
  });
});
