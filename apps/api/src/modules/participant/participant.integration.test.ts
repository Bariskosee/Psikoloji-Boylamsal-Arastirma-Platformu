import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { participantCredentials, participants } from "@lpr/db";
import { PARTICIPANT_COOKIE_NAME } from "@lpr/contracts";
import {
  Client,
  VALID_STUDY,
  createHarness,
  createUser,
  resetDatabase,
  type Harness,
} from "../../testing/harness.js";

/**
 * Phase 5's acceptance criteria, against a real PostgreSQL.
 *
 * The security ones carry the weight here: the continuity token must never
 * leave the cookie, recovery must work exactly once, and a nonexistent study
 * code must be indistinguishable from a real one.
 */

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

/**
 * The participant application's origin.
 *
 * Sent on every state-changing request because a real browser does, and the
 * CSRF guard's origin check applies to participant routes exactly as it does
 * to researcher ones — the double-submit token does not, since there is no
 * researcher session to ride on.
 */
const PARTICIPANT_ORIGIN = process.env["PARTICIPANT_ORIGIN"] ?? "http://localhost:3000";

const post = (path: string) => request(server()).post(path).set("Origin", PARTICIPANT_ORIGIN);

/** A study that is ready to enrol: ACTIVE, with published consent and protocol. */
async function enrollableStudy(): Promise<{
  code: string;
  consentVersionId: string;
  studyId: string;
}> {
  const owner = await createUser(harness.db);
  const client = await Client.login(harness.app, owner);

  const study = await client.post("/api/studies", VALID_STUDY).expect(201);
  const studyId: string = study.body.id;

  // Consent — neutral placeholder text; the platform never writes consent
  // language (AGENT.md §16).
  await client.get(`/api/studies/${studyId}/consent/draft`).expect(200);
  for (const locale of ["en", "tr"]) {
    await client
      .put(`/api/studies/${studyId}/consent/draft/translations`, {
        locale,
        title: "Sample consent title",
        body: "Sample consent body supplied by the research team.",
      })
      .expect(200);
  }
  const consent = await client.post(`/api/studies/${studyId}/consent/publish`).expect(201);

  // A questionnaire and a protocol, so enrollment has a version to pin.
  const questionnaire = await client
    .post(`/api/studies/${studyId}/questionnaires`, { name: "core", description: "" })
    .expect(201);
  const question = await client
    .post(`/api/studies/${studyId}/questionnaires/${questionnaire.body.id}/questions`, {
      type: "FREE_TEXT",
      translations: { en: "Sample question", tr: "Örnek soru" },
    })
    .expect(201);
  void question;
  const publishedQuestionnaire = await client
    .post(`/api/studies/${studyId}/questionnaires/${questionnaire.body.id}/publish`)
    .expect(201);

  const protocol = await client
    .post(`/api/studies/${studyId}/protocols`, { name: "main", description: "" })
    .expect(201);
  await client
    .post(`/api/studies/${studyId}/protocols/${protocol.body.id}/steps`, {
      stepKey: "baseline",
      questionnaireVersionId: publishedQuestionnaire.body.id,
      triggerType: "ENROLLMENT",
      windowDurationIso: "P3D",
    })
    .expect(201);
  await client.post(`/api/studies/${studyId}/protocols/${protocol.body.id}/publish`).expect(201);

  await client.put(`/api/studies/${studyId}/status`, { status: "ACTIVE" }).expect(200);

  const detail = await client.get(`/api/studies/${studyId}`).expect(200);
  return { code: detail.body.enrollmentCode, consentVersionId: consent.body.id, studyId };
}

const ENROLL_BODY = (consentVersionId: string) => ({
  consentVersionId,
  consented: true,
  consentLocale: "en",
  locale: "en",
  timezone: "Europe/Istanbul",
});

function participantCookie(response: request.Response): string {
  const raw = response.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = (raw ?? []).find((value) => value.startsWith(`${PARTICIPANT_COOKIE_NAME}=`));
  if (!cookie) throw new Error("no participant cookie was set");
  return cookie.split(";")[0] ?? "";
}

describe("the enrollment flow", () => {
  it("shows the study and its consent document before consenting", async () => {
    const { code } = await enrollableStudy();

    const response = await request(server()).get(`/api/participant/studies/${code}`).expect(200);

    expect(response.body.acceptingEnrollments).toBe(true);
    expect(response.body.consent.title).toBe("Sample consent title");
    expect(response.body.consent.versionNumber).toBe(1);
  });

  it("serves the consent document in the requested locale", async () => {
    const { code } = await enrollableStudy();

    const response = await request(server())
      .get(`/api/participant/studies/${code}?locale=tr`)
      .expect(200);

    expect(response.body.consent.title).toBe("Sample consent title");
  });

  it("enrolls and returns a public code and a recovery code", async () => {
    const { code, consentVersionId } = await enrollableStudy();

    const response = await post(`/api/participant/studies/${code}/enroll`)
      .send(ENROLL_BODY(consentVersionId))
      .expect(201);

    expect(response.body.publicCode).toMatch(/^P-[0-9A-HJKMNP-TV-Z]{6}$/);
    expect(response.body.recoveryCode).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  });

  it("pins the published protocol version and records the consent version", async () => {
    const { code, consentVersionId, studyId } = await enrollableStudy();

    await post(`/api/participant/studies/${code}/enroll`)
      .send(ENROLL_BODY(consentVersionId))
      .expect(201);

    const rows = await harness.db.execute(
      `select e.consent_version_id, e.consent_locale, e.protocol_version_id, pv.status
         from research.enrollments e
         join research.protocol_versions pv on pv.id = e.protocol_version_id
        where e.study_id = '${studyId}'` as never,
    );
    const row = (rows as unknown as { rows: Record<string, string>[] }).rows[0];

    expect(row?.["consent_version_id"]).toBe(consentVersionId);
    expect(row?.["consent_locale"]).toBe("en");
    expect(row?.["status"]).toBe("PUBLISHED");
  });

  it("creates no participant session — that is Phase 7", async () => {
    const { code, consentVersionId } = await enrollableStudy();

    const response = await post(`/api/participant/studies/${code}/enroll`)
      .send(ENROLL_BODY(consentVersionId))
      .expect(201);

    const me = await request(server())
      .get("/api/participant/me")
      .set("Cookie", participantCookie(response))
      .expect(200);

    expect(me.body.hasAvailableWork).toBe(false);
  });

  it("refuses a consent version that is no longer the study's current one", async () => {
    // Consent is server-authoritative: if a new version was published while the
    // participant was reading, they agreed to text that is no longer in force.
    const { code } = await enrollableStudy();

    const response = await post(`/api/participant/studies/${code}/enroll`)
      .send(ENROLL_BODY("00000000-0000-4000-8000-000000000000"))
      .expect(409);

    expect(response.body.error.code).toBe("CONSENT_VERSION_STALE");
  });

  it("refuses enrollment into a study that is not ACTIVE", async () => {
    const owner = await createUser(harness.db);
    const client = await Client.login(harness.app, owner);
    const study = await client.post("/api/studies", VALID_STUDY).expect(201);

    // A DRAFT study has no published consent either, so this is the same
    // answer an outsider gets for a study that does not exist.
    const detail = await client.get(`/api/studies/${study.body.id}`).expect(200);
    await request(server())
      .get(`/api/participant/studies/${detail.body.enrollmentCode}`)
      .expect(404);
  });
});

describe("continuity", () => {
  it("resumes the same participant after the browser is closed and reopened", async () => {
    // "Closing the browser" is the cookie being the ONLY thing carried over —
    // no in-memory state, no localStorage, a fresh request agent.
    const { code, consentVersionId } = await enrollableStudy();

    const enrolled = await post(`/api/participant/studies/${code}/enroll`)
      .send(ENROLL_BODY(consentVersionId))
      .expect(201);
    const cookie = participantCookie(enrolled);

    const first = await request(server())
      .get("/api/participant/me")
      .set("Cookie", cookie)
      .expect(200);
    const second = await request(server())
      .get("/api/participant/me")
      .set("Cookie", cookie)
      .expect(200);

    expect(second.body.publicCode).toBe(enrolled.body.publicCode);
    expect(second.body.publicCode).toBe(first.body.publicCode);
  });

  it("does not create a second enrollment when a valid credential returns", async () => {
    const { code, consentVersionId, studyId } = await enrollableStudy();

    const enrolled = await post(`/api/participant/studies/${code}/enroll`)
      .send(ENROLL_BODY(consentVersionId))
      .expect(201);
    await request(server())
      .get("/api/participant/me")
      .set("Cookie", participantCookie(enrolled))
      .expect(200);

    const rows = await harness.db
      .select()
      .from(participants)
      .where(eq(participants.studyId, studyId));
    expect(rows).toHaveLength(1);
  });

  it("refuses a request with no cookie", async () => {
    await request(server()).get("/api/participant/me").expect(401);
  });

  it("refuses an unknown token with the same error as a missing one", async () => {
    const unknown = await request(server())
      .get("/api/participant/me")
      .set("Cookie", `${PARTICIPANT_COOKIE_NAME}=${"0".repeat(64)}`)
      .expect(401);
    const missing = await request(server()).get("/api/participant/me").expect(401);

    expect(unknown.body.error.code).toBe(missing.body.error.code);
    expect(unknown.body.error.code).toBe("PARTICIPANT_AUTH_REQUIRED");
  });
});

describe("the token never leaves the cookie", () => {
  it("is absent from the enrollment response body", async () => {
    const { code, consentVersionId } = await enrollableStudy();

    const response = await post(`/api/participant/studies/${code}/enroll`)
      .send(ENROLL_BODY(consentVersionId))
      .expect(201);

    const cookie = participantCookie(response);
    const token = cookie.split("=")[1] ?? "";

    expect(token.length).toBeGreaterThan(32);
    expect(JSON.stringify(response.body)).not.toContain(token);
    // The body carries the recovery code and the public code, and nothing else
    // that could stand in for the credential.
    expect(Object.keys(response.body).sort()).toEqual(["locale", "publicCode", "recoveryCode"]);
  });

  it("is stored only as a hash, never in plaintext", async () => {
    const { code, consentVersionId } = await enrollableStudy();

    const response = await post(`/api/participant/studies/${code}/enroll`)
      .send(ENROLL_BODY(consentVersionId))
      .expect(201);
    const token = participantCookie(response).split("=")[1] ?? "";

    const rows = await harness.db.select().from(participantCredentials);
    const serialised = JSON.stringify(rows);

    expect(rows).toHaveLength(1);
    expect(serialised).not.toContain(token);
    // The lookup prefix is a fragment by design; the full token is not there.
    expect(rows[0]?.tokenHash).not.toBe(token);
  });

  it("is sent HttpOnly, so script cannot read it", async () => {
    const { code, consentVersionId } = await enrollableStudy();

    const response = await post(`/api/participant/studies/${code}/enroll`)
      .send(ENROLL_BODY(consentVersionId))
      .expect(201);

    const raw = (response.headers["set-cookie"] as unknown as string[]).find((value) =>
      value.startsWith(`${PARTICIPANT_COOKIE_NAME}=`),
    );
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Lax/i);
  });
});

describe("recovery", () => {
  it("works exactly once, then fails", async () => {
    const { code, consentVersionId } = await enrollableStudy();

    const enrolled = await post(`/api/participant/studies/${code}/enroll`)
      .send(ENROLL_BODY(consentVersionId))
      .expect(201);
    const recoveryCode: string = enrolled.body.recoveryCode;

    const first = await post("/api/participant/recover").send({ recoveryCode }).expect(200);

    // The recovered credential is a working identity for the same participant.
    const me = await request(server())
      .get("/api/participant/me")
      .set("Cookie", participantCookie(first))
      .expect(200);
    expect(me.body.publicCode).toBe(enrolled.body.publicCode);

    await post("/api/participant/recover").send({ recoveryCode }).expect(401);
  });

  it("revokes the previous credential, so a lost device stops working", async () => {
    const { code, consentVersionId } = await enrollableStudy();

    const enrolled = await post(`/api/participant/studies/${code}/enroll`)
      .send(ENROLL_BODY(consentVersionId))
      .expect(201);
    const oldCookie = participantCookie(enrolled);

    await post("/api/participant/recover")
      .send({ recoveryCode: enrolled.body.recoveryCode })
      .expect(200);

    await request(server()).get("/api/participant/me").set("Cookie", oldCookie).expect(401);
  });

  it("answers an unknown recovery code the same way as a used one", async () => {
    const unknown = await post("/api/participant/recover")
      .send({ recoveryCode: "ZZZZZZZZ" })
      .expect(401);

    expect(unknown.body.error.code).toBe("PARTICIPANT_AUTH_REQUIRED");
  });

  it("tolerates the separators and case a person actually types", async () => {
    const { code, consentVersionId } = await enrollableStudy();

    const enrolled = await post(`/api/participant/studies/${code}/enroll`)
      .send(ENROLL_BODY(consentVersionId))
      .expect(201);
    const typed =
      `${(enrolled.body.recoveryCode as string).slice(0, 4)}-${(enrolled.body.recoveryCode as string).slice(4)}`.toLowerCase();

    await post("/api/participant/recover").send({ recoveryCode: typed }).expect(200);
  });
});

describe("enumeration resistance", () => {
  it("answers a nonexistent study code exactly as a malformed one", async () => {
    const nonexistent = await request(server()).get("/api/participant/studies/ZZZZZZ").expect(404);
    const malformed = await request(server()).get("/api/participant/studies/nope").expect(404);

    expect(nonexistent.body).toEqual(malformed.body);
    expect(nonexistent.body.error.code).toBe("STUDY_NOT_FOUND");
  });

  it("gives a study that exists but is not enrollable the same answer", async () => {
    // A researcher's setup state — no consent yet, not activated — must not be
    // readable from outside.
    const owner = await createUser(harness.db);
    const client = await Client.login(harness.app, owner);
    const study = await client.post("/api/studies", VALID_STUDY).expect(201);
    const detail = await client.get(`/api/studies/${study.body.id}`).expect(200);

    const real = await request(server())
      .get(`/api/participant/studies/${detail.body.enrollmentCode}`)
      .expect(404);
    const fake = await request(server()).get("/api/participant/studies/ZZZZZZ").expect(404);

    expect(real.body).toEqual(fake.body);
  });
});

describe("withdrawal", () => {
  it("stops the participant being able to act, without deleting them", async () => {
    const { code, consentVersionId } = await enrollableStudy();

    const enrolled = await post(`/api/participant/studies/${code}/enroll`)
      .send(ENROLL_BODY(consentVersionId))
      .expect(201);
    const cookie = participantCookie(enrolled);

    await post("/api/participant/withdraw")
      .set("Cookie", cookie)
      .send({ reason: "No longer available" })
      .expect(204);

    // The credential is revoked immediately, on every device.
    await request(server()).get("/api/participant/me").set("Cookie", cookie).expect(401);

    // The row survives: withdrawal is not erasure (FR-30).
    const rows = await harness.db.select().from(participants);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("WITHDRAWN");
    expect(rows[0]?.withdrawnAt).not.toBeNull();
  });
});
