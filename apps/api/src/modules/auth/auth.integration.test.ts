import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, isNull } from "drizzle-orm";
import { auditEvents, researcherSessions } from "@lpr/db";
import {
  Client,
  CSRF_COOKIE_NAME,
  CSRF_HEADER,
  RESEARCHER_ORIGIN,
  SESSION_COOKIE_NAME,
  cookieValue,
  createHarness,
  createUser,
  resetDatabase,
  type Harness,
} from "../../testing/harness.js";

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

const server = () => harness.app.getHttpServer();

describe("POST /api/auth/login", () => {
  it("authenticates a researcher and sets both cookies", async () => {
    const user = await createUser(harness.db);

    const response = await request(server())
      .post("/api/auth/login")
      .set("Origin", RESEARCHER_ORIGIN)
      .send({ email: user.email, password: user.password })
      .expect(200);

    expect(response.body.user.email).toBe(user.email);
    expect(response.body.csrfToken).toBeTruthy();

    const cookies = response.headers["set-cookie"] as unknown as string[];
    const session = cookies.find((c) => c.startsWith(SESSION_COOKIE_NAME));
    const csrf = cookies.find((c) => c.startsWith(CSRF_COOKIE_NAME));

    // HttpOnly on the session so an XSS cannot read it; deliberately NOT on
    // the CSRF cookie, because the double-submit mechanism requires script to
    // read that one.
    expect(session).toContain("HttpOnly");
    expect(session).toContain("SameSite=Lax");
    expect(csrf).not.toContain("HttpOnly");
  });

  it("never returns the password hash or the session token in the body", async () => {
    const user = await createUser(harness.db);
    const response = await request(server())
      .post("/api/auth/login")
      .set("Origin", RESEARCHER_ORIGIN)
      .send({ email: user.email, password: user.password })
      .expect(200);

    const serialised = JSON.stringify(response.body);
    expect(serialised).not.toContain("argon2");
    expect(serialised).not.toContain("passwordHash");
    // The session token lives only in the HttpOnly cookie.
    const token = cookieValue(response, SESSION_COOKIE_NAME);
    expect(serialised).not.toContain(token);
  });

  it("accepts an email in any case, because the schema normalises it", async () => {
    const user = await createUser(harness.db, { email: `mixed-${Date.now()}@example.org` });
    await request(server())
      .post("/api/auth/login")
      .set("Origin", RESEARCHER_ORIGIN)
      .send({ email: user.email.toUpperCase(), password: user.password })
      .expect(200);
  });

  describe("uniform failure (STRUCTURE.md §11.5)", () => {
    /**
     * Every failure mode must be indistinguishable. Any difference between
     * them is an account-enumeration oracle — and on a research platform,
     * knowing WHO holds an account is itself disclosure.
     */
    it("returns INVALID_CREDENTIALS for a wrong password", async () => {
      const user = await createUser(harness.db);
      const response = await request(server())
        .post("/api/auth/login")
        .set("Origin", RESEARCHER_ORIGIN)
        .send({ email: user.email, password: "not the right password" })
        .expect(401);
      expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("returns the SAME code for an email with no account", async () => {
      const response = await request(server())
        .post("/api/auth/login")
        .set("Origin", RESEARCHER_ORIGIN)
        .send({ email: "nobody@example.org", password: "a quiet forest of pines" })
        .expect(401);
      expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("returns the SAME code for a disabled account, with the correct password", async () => {
      const user = await createUser(harness.db, { isActive: false });
      const response = await request(server())
        .post("/api/auth/login")
        .set("Origin", RESEARCHER_ORIGIN)
        .send({ email: user.email, password: user.password })
        .expect(401);
      expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
    });

    it("spends comparable time on a missing account as on a real one", async () => {
      // Without the dummy-hash path, "no such user" returns in microseconds
      // while a real account pays for argon2id — a timing oracle no amount of
      // response-body care can hide.
      const user = await createUser(harness.db);

      const timeOf = async (email: string): Promise<number> => {
        const started = process.hrtime.bigint();
        await request(server())
          .post("/api/auth/login")
          .set("Origin", RESEARCHER_ORIGIN)
          .send({ email, password: "wrong password entirely" });
        return Number(process.hrtime.bigint() - started) / 1e6;
      };

      const known = await timeOf(user.email);
      const unknown = await timeOf(`ghost-${Date.now()}@example.org`);

      // Generous bound: this asserts the dummy verification happens at all,
      // not a precise constant time, which no test on a shared runner can.
      expect(unknown).toBeGreaterThan(known * 0.25);
    });
  });

  it("rate limits repeated attempts and says when to retry", async () => {
    const user = await createUser(harness.db);
    const attempt = () =>
      request(server())
        .post("/api/auth/login")
        .set("Origin", RESEARCHER_ORIGIN)
        .send({ email: user.email, password: "wrong" });

    for (let i = 0; i < 5; i += 1) await attempt().expect(401);

    const blocked = await attempt().expect(429);
    expect(blocked.body.error.code).toBe("RATE_LIMITED");
    expect(blocked.body.error.message).toMatch(/Retry in \d+s/);
  });

  it("records both successful and failed attempts in the audit trail (NFR-05)", async () => {
    const user = await createUser(harness.db);

    await request(server())
      .post("/api/auth/login")
      .set("Origin", RESEARCHER_ORIGIN)
      .send({ email: user.email, password: "wrong" })
      .expect(401);
    await request(server())
      .post("/api/auth/login")
      .set("Origin", RESEARCHER_ORIGIN)
      .send({ email: user.email, password: user.password })
      .expect(200);

    const events = await harness.db.select().from(auditEvents);
    const actions = events.map((event) => event.action);
    expect(actions).toContain("auth.login.failed");
    expect(actions).toContain("auth.login.succeeded");

    const failure = events.find((event) => event.action === "auth.login.failed");
    // The email is recorded because "forty attempts against this account" is
    // the question the trail exists to answer; actorId stays null so the
    // attempt is not attributed to the account holder.
    expect(failure?.actorLabel).toBe(user.email);
    expect(failure?.actorId).toBeNull();
  });

  it("rejects a malformed body with field-level detail", async () => {
    const response = await request(server())
      .post("/api/auth/login")
      .set("Origin", RESEARCHER_ORIGIN)
      .send({ email: "not-an-email", password: "" })
      .expect(400);

    expect(response.body.error.code).toBe("VALIDATION_FAILED");
    expect(response.body.error.details.map((d: { path: string }) => d.path)).toContain("email");
  });
});

describe("session lifecycle", () => {
  it("resolves the session on a subsequent request", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);

    const me = await client.get("/api/auth/me").expect(200);
    expect(me.body.user.email).toBe(user.email);
  });

  it("requires authentication without a cookie", async () => {
    const response = await request(server()).get("/api/auth/me").expect(401);
    expect(response.body.error.code).toBe("AUTHENTICATION_REQUIRED");
  });

  it("invalidates the session server-side IMMEDIATELY on logout", async () => {
    // The acceptance criterion this phase is judged on: a signed token would
    // stay valid until expiry no matter what the server decided.
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);

    await client.post("/api/auth/logout").expect(204);

    const after = await client.get("/api/auth/me").expect(401);
    expect(after.body.error.code).toBe("SESSION_EXPIRED");
  });

  it("marks the row revoked rather than deleting it", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);
    await client.post("/api/auth/logout").expect(204);

    const rows = await harness.db
      .select()
      .from(researcherSessions)
      .where(eq(researcherSessions.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.revokedAt).not.toBeNull();
  });

  it("stores only a hash of the token, never the token", async () => {
    const user = await createUser(harness.db);
    const response = await request(server())
      .post("/api/auth/login")
      .set("Origin", RESEARCHER_ORIGIN)
      .send({ email: user.email, password: user.password })
      .expect(200);

    const token = cookieValue(response, SESSION_COOKIE_NAME)!;
    const rows = await harness.db.select().from(researcherSessions);
    expect(rows[0]!.tokenHash).not.toBe(token);
    expect(rows[0]!.tokenHash).toHaveLength(64);
  });

  it("mints a fresh token on every login, so a fixated session is never inherited", async () => {
    const user = await createUser(harness.db);
    const first = await Client.login(harness.app, user);
    const second = await Client.login(harness.app, user);

    expect(second.csrfToken).not.toBe(first.csrfToken);
    expect(second.cookies).not.toEqual(first.cookies);
  });

  it("keeps concurrent sessions from different devices alive", async () => {
    // Multi-device is normal for a researcher — a laptop and a phone. Session
    // fixation is prevented by always minting a NEW token, not by allowing
    // only one session per account.
    const user = await createUser(harness.db);
    const laptop = await Client.login(harness.app, user);
    const phone = await Client.login(harness.app, user);

    await laptop.get("/api/auth/me").expect(200);
    await phone.get("/api/auth/me").expect(200);

    const live = await harness.db
      .select()
      .from(researcherSessions)
      .where(and(eq(researcherSessions.userId, user.id), isNull(researcherSessions.revokedAt)));
    expect(live).toHaveLength(2);
  });

  it("replaces, rather than accumulates, when logging in on a browser that already has a session", async () => {
    // The same browser logging in again — as a second account, or after a
    // partial logout — must not leave the previous session alive behind it.
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);

    await request(server())
      .post("/api/auth/login")
      .set("Cookie", client.cookies)
      .set("Origin", RESEARCHER_ORIGIN)
      .set(CSRF_HEADER, client.csrfToken)
      .send({ email: user.email, password: user.password })
      .expect(200);

    await client.get("/api/auth/me").expect(401);

    const live = await harness.db
      .select()
      .from(researcherSessions)
      .where(and(eq(researcherSessions.userId, user.id), isNull(researcherSessions.revokedAt)));
    expect(live).toHaveLength(1);
  });

  it("rejects a session belonging to a deactivated account on the next request", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);
    await client.get("/api/auth/me").expect(200);

    await harness.db.execute(
      `UPDATE identity.researcher_users SET is_active = false WHERE id = '${user.id}'` as never,
    );

    await client.get("/api/auth/me").expect(401);
  });
});

describe("CSRF protection (STRUCTURE.md §11.5)", () => {
  it("rejects a mutation with no Origin or Referer", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);

    const response = await request(server())
      .post("/api/studies")
      .set("Cookie", client.cookies)
      .set(CSRF_HEADER, client.csrfToken)
      .send({ name: "x" })
      .expect(403);

    expect(response.body.error.code).toBe("CSRF_FAILED");
  });

  it("rejects a mutation from an origin that is not ours", async () => {
    // A fully VALID session and a valid CSRF token. Only the origin is wrong,
    // which is exactly the shape of a cross-site forgery.
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);

    const response = await request(server())
      .post("/api/studies")
      .set("Cookie", client.cookies)
      .set("Origin", "https://evil.example.com")
      .set(CSRF_HEADER, client.csrfToken)
      .send({})
      .expect(403);

    expect(response.body.error.code).toBe("CSRF_FAILED");
  });

  it("rejects an authenticated mutation with no double-submit token", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);

    const response = await client.postWithoutCsrf("/api/studies", {}).expect(403);
    expect(response.body.error.code).toBe("CSRF_FAILED");
  });

  it("rejects a wrong double-submit token", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);

    const response = await request(server())
      .post("/api/studies")
      .set("Cookie", client.cookies)
      .set("Origin", RESEARCHER_ORIGIN)
      .set(CSRF_HEADER, "a-token-from-somewhere-else")
      .send({})
      .expect(403);

    expect(response.body.error.code).toBe("CSRF_FAILED");
  });

  it("rejects an unresolvable session before it reaches the CSRF check", async () => {
    // Guard order: authentication first. A forged cookie is 401, not 403 —
    // the caller is not authenticated, so there is no session to forge against.
    const response = await request(server())
      .post("/api/studies")
      .set("Cookie", [`${SESSION_COOKIE_NAME}=not-a-real-token`])
      .set("Origin", RESEARCHER_ORIGIN)
      .send({})
      .expect(401);

    expect(response.body.error.code).toBe("SESSION_EXPIRED");
  });

  it("protects login itself with the origin check", async () => {
    // A cross-site login CSRF signs the victim into the ATTACKER's account,
    // after which everything the victim does is visible to the attacker.
    const user = await createUser(harness.db);
    const response = await request(server())
      .post("/api/auth/login")
      .set("Origin", "https://evil.example.com")
      .send({ email: user.email, password: user.password })
      .expect(403);
    expect(response.body.error.code).toBe("CSRF_FAILED");
  });

  it("does not obstruct safe methods", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);
    await client.get("/api/auth/me").expect(200);
  });
});

describe("POST /api/auth/password", () => {
  it("changes the password and ends every OTHER session", async () => {
    const user = await createUser(harness.db);
    const first = await Client.login(harness.app, user);
    const second = await Client.login(harness.app, user);

    const response = await second
      .post("/api/auth/password", {
        currentPassword: user.password,
        newPassword: "an entirely different passphrase",
      })
      .expect(200);

    // The session that made the change survives; anything else — including a
    // stolen session, which is the reason people change passwords — does not.
    expect(response.body.revokedSessions).toBeGreaterThanOrEqual(0);
    await second.get("/api/auth/me").expect(200);
    await first.get("/api/auth/me").expect(401);
  });

  it("requires the current password", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);

    const response = await client
      .post("/api/auth/password", {
        currentPassword: "not the current one",
        newPassword: "an entirely different passphrase",
      })
      .expect(401);
    expect(response.body.error.code).toBe("INVALID_CREDENTIALS");
  });

  it("enforces the password policy on the new password", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);

    const response = await client
      .post("/api/auth/password", {
        currentPassword: user.password,
        newPassword: "Password1234",
      })
      .expect(400);
    expect(response.body.error.code).toBe("PASSWORD_TOO_WEAK");
  });

  it("never writes the password into the audit trail", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);
    const newPassword = "a completely new passphrase here";

    await client
      .post("/api/auth/password", { currentPassword: user.password, newPassword })
      .expect(200);

    const events = await harness.db.select().from(auditEvents);
    const serialised = JSON.stringify(events);
    expect(serialised).not.toContain(newPassword);
    expect(serialised).not.toContain(user.password);
    expect(events.map((e) => e.action)).toContain("auth.password.changed");
  });

  it("lets the new password log in and the old one fail", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);
    const newPassword = "a completely new passphrase here";

    await client
      .post("/api/auth/password", { currentPassword: user.password, newPassword })
      .expect(200);

    await request(server())
      .post("/api/auth/login")
      .set("Origin", RESEARCHER_ORIGIN)
      .send({ email: user.email, password: newPassword })
      .expect(200);

    await request(server())
      .post("/api/auth/login")
      .set("Origin", RESEARCHER_ORIGIN)
      .send({ email: user.email, password: user.password })
      .expect(401);
  });
});
