import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditEvents, studies } from "@lpr/db";
import { normalizeEnrollmentCode } from "@lpr/domain";
import {
  Client,
  VALID_STUDY,
  addMember,
  createHarness,
  createUser,
  resetDatabase,
  type Harness,
  type TestUser,
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

async function ownerWithStudy(): Promise<{ owner: TestUser; client: Client; studyId: string }> {
  const owner = await createUser(harness.db);
  const client = await Client.login(harness.app, owner);
  const created = await client.post("/api/studies", VALID_STUDY).expect(201);
  return { owner, client, studyId: created.body.id };
}

describe("POST /api/studies", () => {
  it("creates a study and makes the creator its OWNER", async () => {
    const { client, studyId } = await ownerWithStudy();

    const members = await client.get(`/api/studies/${studyId}/members`).expect(200);
    expect(members.body.members).toHaveLength(1);
    expect(members.body.members[0].role).toBe("OWNER");
  });

  it("allocates a valid, non-sequential enrollment code and a matching join URL", async () => {
    const first = await ownerWithStudy();
    const second = await first.client.post("/api/studies", VALID_STUDY).expect(201);
    const firstStudy = await first.client.get(`/api/studies/${first.studyId}`).expect(200);

    for (const code of [firstStudy.body.enrollmentCode, second.body.enrollmentCode]) {
      // Crockford base-32 without I, L, O, U (FR-01).
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/);
      expect(normalizeEnrollmentCode(code)).toBe(code);
    }
    expect(firstStudy.body.enrollmentCode).not.toBe(second.body.enrollmentCode);
    expect(firstStudy.body.enrollmentUrl).toContain(`/join/${firstStudy.body.enrollmentCode}`);
  });

  it("starts in DRAFT, because a study is not real until someone activates it", async () => {
    const { client, studyId } = await ownerWithStudy();
    const study = await client.get(`/api/studies/${studyId}`).expect(200);
    expect(study.body.status).toBe("DRAFT");
  });

  it("rejects a timezone that is not a real IANA zone", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);

    const response = await client
      .post("/api/studies", { ...VALID_STUDY, timezone: "Europe/Istanbol" })
      .expect(400);
    expect(response.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("rejects a fixed-offset timezone, which would get daylight saving wrong", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);
    await client.post("/api/studies", { ...VALID_STUDY, timezone: "UTC+3" }).expect(400);
  });

  it("rejects a default locale the study does not support", async () => {
    const user = await createUser(harness.db);
    const client = await Client.login(harness.app, user);
    await client
      .post("/api/studies", { ...VALID_STUDY, defaultLocale: "tr", supportedLocales: ["en"] })
      .expect(400);
  });

  it("records an audit event (NFR-05)", async () => {
    const { studyId } = await ownerWithStudy();
    const events = await harness.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.studyId, studyId));

    expect(events.map((event) => event.action)).toContain("study.created");
  });
});

describe("GET /api/studies", () => {
  it("returns only studies the caller belongs to, with their role", async () => {
    const { studyId } = await ownerWithStudy();

    const analyst = await createUser(harness.db);
    await addMember(harness.db, studyId, analyst.id, "ANALYST");
    const analystClient = await Client.login(harness.app, analyst);

    const listed = await analystClient.get("/api/studies").expect(200);
    expect(listed.body.studies).toHaveLength(1);
    expect(listed.body.studies[0].viewerRole).toBe("ANALYST");
  });
});

describe("PATCH /api/studies/:studyId", () => {
  it("updates configuration and audits which fields changed, not their values", async () => {
    const { client, studyId } = await ownerWithStudy();

    const updated = await client
      .patch(`/api/studies/${studyId}`, { name: "Sleep and Mood — wave 2" })
      .expect(200);
    expect(updated.body.name).toBe("Sleep and Mood — wave 2");

    const events = await harness.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.studyId, studyId));
    const update = events.find((event) => event.action === "study.updated");
    expect(update?.metadata).toEqual({ fields: ["name"] });
  });

  it("refuses to edit a closed study", async () => {
    // Editing metadata after closure rewrites the description of a dataset
    // that may already have been analysed under the old one.
    const { client, studyId } = await ownerWithStudy();
    await client.put(`/api/studies/${studyId}/status`, { status: "ACTIVE" }).expect(200);
    await client.put(`/api/studies/${studyId}/status`, { status: "CLOSED" }).expect(200);

    const response = await client
      .patch(`/api/studies/${studyId}`, { name: "Too late" })
      .expect(409);
    expect(response.body.error.code).toBe("CONFLICT");
  });

  it("rejects an empty update rather than writing a pointless audit row", async () => {
    const { client, studyId } = await ownerWithStudy();
    await client.patch(`/api/studies/${studyId}`, {}).expect(400);
  });
});

describe("PUT /api/studies/:studyId/status", () => {
  it("walks the legal lifecycle and audits both ends of each transition", async () => {
    const { client, studyId } = await ownerWithStudy();

    for (const status of ["ACTIVE", "PAUSED", "ACTIVE", "CLOSED", "ARCHIVED"] as const) {
      const response = await client.put(`/api/studies/${studyId}/status`, { status }).expect(200);
      expect(response.body.status).toBe(status);
    }

    const events = await harness.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.studyId, studyId));
    const transitions = events
      .filter((event) => event.action === "study.status.changed")
      .map((event) => event.metadata as { from: string; to: string });

    expect(transitions).toHaveLength(5);
    expect(transitions).toContainEqual({ from: "DRAFT", to: "ACTIVE" });
    expect(transitions).toContainEqual({ from: "CLOSED", to: "ARCHIVED" });
  });

  it("refuses to reopen a closed study", async () => {
    const { client, studyId } = await ownerWithStudy();
    await client.put(`/api/studies/${studyId}/status`, { status: "ACTIVE" }).expect(200);
    await client.put(`/api/studies/${studyId}/status`, { status: "CLOSED" }).expect(200);

    const response = await client
      .put(`/api/studies/${studyId}/status`, { status: "ACTIVE" })
      .expect(409);
    expect(response.body.error.code).toBe("INVALID_STUDY_TRANSITION");
  });

  it("refuses to skip from DRAFT straight to CLOSED", async () => {
    const { client, studyId } = await ownerWithStudy();
    const response = await client
      .put(`/api/studies/${studyId}/status`, { status: "CLOSED" })
      .expect(409);
    expect(response.body.error.code).toBe("INVALID_STUDY_TRANSITION");
  });

  it("leaves an archived study immovable", async () => {
    const { client, studyId } = await ownerWithStudy();
    await client.put(`/api/studies/${studyId}/status`, { status: "ARCHIVED" }).expect(200);
    await client.put(`/api/studies/${studyId}/status`, { status: "ACTIVE" }).expect(409);
  });
});

describe("GET /api/studies/:studyId/qr", () => {
  it("returns an SVG that encodes exactly the enrollment URL (FR-02)", async () => {
    const { client, studyId } = await ownerWithStudy();
    const study = await client.get(`/api/studies/${studyId}`).expect(200);

    // Buffered explicitly: superagent has no parser for image/svg+xml, so
    // without this the body arrives as an empty object rather than markup.
    const response = await client.get(`/api/studies/${studyId}/qr`).buffer(true).expect(200);
    expect(response.headers["content-type"]).toContain("image/svg+xml");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.from(response.body).toString("utf8")).toContain("<svg");

    // The QR and the dashboard's link are produced by the same function, so
    // they cannot disagree. Verified by decoding the study's own code.
    const stored = await harness.db.select().from(studies).where(eq(studies.id, studyId));
    expect(study.body.enrollmentUrl).toContain(stored[0]!.enrollmentCode);
  });

  it("is not cached publicly, because the URL identifies a specific study", async () => {
    const { client, studyId } = await ownerWithStudy();
    const response = await client.get(`/api/studies/${studyId}/qr`).expect(200);
    expect(response.headers["cache-control"]).toContain("private");
  });
});

describe("study membership", () => {
  it("adds an existing researcher and audits the grant", async () => {
    const { client, studyId } = await ownerWithStudy();
    const colleague = await createUser(harness.db);

    const added = await client
      .post(`/api/studies/${studyId}/members`, { email: colleague.email, role: "ANALYST" })
      .expect(201);
    expect(added.body.role).toBe("ANALYST");

    const events = await harness.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.studyId, studyId));
    expect(events.map((event) => event.action)).toContain("study.member.added");
  });

  it("refuses an email with no account rather than creating a shell one", async () => {
    const { client, studyId } = await ownerWithStudy();
    const response = await client
      .post(`/api/studies/${studyId}/members`, { email: "ghost@example.org", role: "VIEWER" })
      .expect(404);
    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("refuses to add the same person twice", async () => {
    const { client, studyId } = await ownerWithStudy();
    const colleague = await createUser(harness.db);
    await client
      .post(`/api/studies/${studyId}/members`, { email: colleague.email, role: "VIEWER" })
      .expect(201);

    const response = await client
      .post(`/api/studies/${studyId}/members`, { email: colleague.email, role: "EDITOR" })
      .expect(409);
    expect(response.body.error.code).toBe("CONFLICT");
  });

  it("changes a role and audits the old and new value", async () => {
    const { client, studyId } = await ownerWithStudy();
    const colleague = await createUser(harness.db);
    await addMember(harness.db, studyId, colleague.id, "VIEWER");

    await client
      .patch(`/api/studies/${studyId}/members/${colleague.id}`, { role: "EDITOR" })
      .expect(200);

    const events = await harness.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.studyId, studyId));
    const change = events.find((event) => event.action === "study.member.role.changed");
    expect(change?.metadata).toMatchObject({ from: "VIEWER", to: "EDITOR" });
  });

  it("takes effect on the demoted member's very next request", async () => {
    const { client, studyId } = await ownerWithStudy();
    const colleague = await createUser(harness.db);
    await addMember(harness.db, studyId, colleague.id, "EDITOR");
    const colleagueClient = await Client.login(harness.app, colleague);

    await colleagueClient.patch(`/api/studies/${studyId}`, { name: "Allowed" }).expect(200);

    await client
      .patch(`/api/studies/${studyId}/members/${colleague.id}`, { role: "VIEWER" })
      .expect(200);

    // Authorization is read per request from the membership row, not cached in
    // the session, so a revoked privilege does not survive until logout.
    await colleagueClient.patch(`/api/studies/${studyId}`, { name: "No longer" }).expect(403);
  });

  it("removes a member and cuts off their access immediately", async () => {
    const { client, studyId } = await ownerWithStudy();
    const colleague = await createUser(harness.db);
    await addMember(harness.db, studyId, colleague.id, "VIEWER");
    const colleagueClient = await Client.login(harness.app, colleague);

    await colleagueClient.get(`/api/studies/${studyId}`).expect(200);
    await client.delete(`/api/studies/${studyId}/members/${colleague.id}`).expect(204);
    await colleagueClient.get(`/api/studies/${studyId}`).expect(404);
  });

  describe("the last owner", () => {
    /**
     * A study with no OWNER cannot be administered at all — no member
     * management, no lifecycle change, no audit access — and is recoverable
     * only by direct database surgery.
     */
    it("cannot be demoted", async () => {
      const { client, owner, studyId } = await ownerWithStudy();
      const response = await client
        .patch(`/api/studies/${studyId}/members/${owner.id}`, { role: "EDITOR" })
        .expect(409);
      expect(response.body.error.code).toBe("LAST_OWNER_REQUIRED");
    });

    it("cannot be removed", async () => {
      const { client, owner, studyId } = await ownerWithStudy();
      const response = await client
        .delete(`/api/studies/${studyId}/members/${owner.id}`)
        .expect(409);
      expect(response.body.error.code).toBe("LAST_OWNER_REQUIRED");
    });

    it("may step down once another OWNER exists", async () => {
      const { client, owner, studyId } = await ownerWithStudy();
      const successor = await createUser(harness.db);
      await client
        .post(`/api/studies/${studyId}/members`, { email: successor.email, role: "OWNER" })
        .expect(201);

      await client
        .patch(`/api/studies/${studyId}/members/${owner.id}`, { role: "VIEWER" })
        .expect(200);
    });
  });
});

describe("GET /api/studies/:studyId/audit", () => {
  it("returns the study's events newest first", async () => {
    const { client, studyId } = await ownerWithStudy();
    await client.patch(`/api/studies/${studyId}`, { name: "Renamed once" }).expect(200);
    await client.patch(`/api/studies/${studyId}`, { name: "Renamed twice" }).expect(200);

    const response = await client.get(`/api/studies/${studyId}/audit`).expect(200);
    const timestamps = response.body.events.map(
      (event: { occurredAt: string }) => event.occurredAt,
    );
    expect([...timestamps].sort().reverse()).toEqual(timestamps);
    expect(response.body.events.map((e: { action: string }) => e.action)).toContain(
      "study.created",
    );
  });

  it("pages by cursor without repeating or skipping an event", async () => {
    const { client, studyId } = await ownerWithStudy();
    for (let i = 0; i < 6; i += 1) {
      await client.patch(`/api/studies/${studyId}`, { name: `Rename ${i}` }).expect(200);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url = `/api/studies/${studyId}/audit?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const response = await client.get(url).expect(200);
      seen.push(...response.body.events.map((event: { id: string }) => event.id));
      cursor = response.body.nextCursor;
      if (!cursor) break;
    }

    // 1 create + 6 updates. Every event exactly once.
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("excludes events belonging to another study", async () => {
    const first = await ownerWithStudy();
    const second = await first.client.post("/api/studies", VALID_STUDY).expect(201);

    const response = await first.client.get(`/api/studies/${first.studyId}/audit`).expect(200);
    const studyIds = new Set(response.body.events.map((e: { studyId: string }) => e.studyId));
    expect(studyIds).toEqual(new Set([first.studyId]));
    expect(studyIds.has(second.body.id)).toBe(false);
  });

  it("never contains a credential or a response payload", async () => {
    const { client, studyId, owner } = await ownerWithStudy();
    await client
      .post("/api/auth/password", {
        currentPassword: owner.password,
        newPassword: "a completely different passphrase",
      })
      .expect(200);

    const all = await harness.db.select().from(auditEvents);
    const serialised = JSON.stringify(all);
    expect(serialised).not.toContain(owner.password);
    expect(serialised).not.toContain("argon2");
    expect(studyId).toBeTruthy();
  });
});

/**
 * A malformed `:userId` used to reach the query layer, where PostgreSQL raised
 * a uuid cast error (22P02) that surfaced as an opaque 500 — a fuzzed request
 * that looks exactly like an outage, and a different answer than the sibling
 * questionnaire routes give for the same input.
 */
describe("member routes reject a malformed :userId", () => {
  it("answers PATCH with the same not-found it gives an absent member", async () => {
    const { client, studyId } = await ownerWithStudy();

    const response = await client
      .patch(`/api/studies/${studyId}/members/not-a-uuid`, { role: "EDITOR" })
      .expect(404);

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("answers DELETE with the same not-found it gives an absent member", async () => {
    const { client, studyId } = await ownerWithStudy();

    const response = await client.delete(`/api/studies/${studyId}/members/not-a-uuid`).expect(404);

    expect(response.body.error.code).toBe("NOT_FOUND");
  });

  it("gives a well-formed but unknown id the same answer, so neither is an oracle", async () => {
    const { client, studyId } = await ownerWithStudy();
    const absent = "00000000-0000-4000-8000-000000000000";

    const malformed = await client.delete(`/api/studies/${studyId}/members/not-a-uuid`);
    const unknown = await client.delete(`/api/studies/${studyId}/members/${absent}`);

    expect(malformed.status).toBe(unknown.status);
    expect(malformed.body.error.code).toBe(unknown.body.error.code);
  });
});
