import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { notificationAttempts, participantSessions, participants } from "@lpr/db";
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
 * The participant's side of the notification record (PLAN.md Phase 9, FR-19).
 *
 * The API never sends — the worker owns that. What is asserted here is the
 * boundary around the record: a client may annotate an attempt that is theirs,
 * and may learn nothing whatsoever about anybody else's.
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
const PARTICIPANT_ORIGIN = process.env["PARTICIPANT_ORIGIN"] ?? "http://localhost:3000";

async function enrollableStudy(): Promise<{ code: string; consentVersionId: string }> {
  const owner = await createUser(harness.db);
  const client = await Client.login(harness.app, owner);

  const study = await client.post("/api/studies", VALID_STUDY).expect(201);
  const studyId: string = study.body.id;

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

  const questionnaire = await client
    .post(`/api/studies/${studyId}/questionnaires`, { name: "core", description: "" })
    .expect(201);
  await client
    .post(`/api/studies/${studyId}/questionnaires/${questionnaire.body.id}/questions`, {
      type: "FREE_TEXT",
      translations: { en: "Sample question", tr: "Örnek soru" },
      isRequired: false,
    })
    .expect(201);
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
  return { code: detail.body.enrollmentCode, consentVersionId: consent.body.id };
}

function participantCookie(response: request.Response): string {
  const raw = response.headers["set-cookie"] as unknown as string[] | undefined;
  const cookie = (raw ?? []).find((value) => value.startsWith(`${PARTICIPANT_COOKIE_NAME}=`));
  if (!cookie) throw new Error("no participant cookie was set");
  return cookie.split(";")[0] ?? "";
}

/** Enrol, and return the credential plus the session the engine materialised. */
async function enrol(): Promise<{ cookie: string; participantId: string; sessionId: string }> {
  const { code, consentVersionId } = await enrollableStudy();

  const response = await request(server())
    .post(`/api/participant/studies/${code}/enroll`)
    .set("Origin", PARTICIPANT_ORIGIN)
    .send({
      consentVersionId,
      consented: true,
      consentLocale: "en",
      locale: "en",
      timezone: "Europe/Istanbul",
    })
    .expect(201);

  const cookie = participantCookie(response);
  const me = await request(server())
    .get("/api/participant/me")
    .set("Cookie", cookie)
    .set("Origin", PARTICIPANT_ORIGIN)
    .expect(200);

  const participant = (
    await harness.db
      .select({ id: participants.id })
      .from(participants)
      .where(eq(participants.publicCode, me.body.publicCode))
      .limit(1)
  )[0];
  if (!participant) throw new Error("enrolled participant not found");

  const session = (
    await harness.db
      .select({ id: participantSessions.id })
      .from(participantSessions)
      .where(eq(participantSessions.participantId, participant.id))
      .limit(1)
  )[0];
  if (!session) throw new Error("no session was materialised for the participant");

  return { cookie, participantId: participant.id, sessionId: session.id };
}

/** The worker writes these; here they are seeded directly. */
async function seedAttempt(
  participantId: string,
  sessionId: string,
  overrides: Partial<typeof notificationAttempts.$inferInsert> = {},
): Promise<void> {
  await harness.db.insert(notificationAttempts).values({
    sessionId,
    participantId,
    kind: "INITIAL",
    occurrenceIndex: 0,
    scheduledFor: new Date(),
    attemptedAt: new Date(),
    outcome: "SENT_ACCEPTED",
    ...overrides,
  });
}

const participant = (cookie: string) => ({
  get: (path: string) =>
    request(server()).get(path).set("Cookie", cookie).set("Origin", PARTICIPANT_ORIGIN),
  post: (path: string, body?: unknown) =>
    request(server())
      .post(path)
      .set("Cookie", cookie)
      .set("Origin", PARTICIPANT_ORIGIN)
      .send(body as object),
});

describe("client event reporting", () => {
  it("annotates an existing attempt rather than creating one", async () => {
    // A client report is new information ABOUT an attempt, never a new event of
    // its own. Modelling it as an insert would let a device fabricate contacts
    // that never happened and inflate every outreach count in the study.
    const { cookie, participantId, sessionId } = await enrol();
    await seedAttempt(participantId, sessionId);

    await participant(cookie)
      .post("/api/participant/notifications/events", {
        sessionId,
        kind: "INITIAL",
        occurrenceIndex: 0,
        event: "CLICKED",
      })
      .expect(204);

    const rows = await harness.db.select().from(notificationAttempts);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clickedAt).not.toBeNull();
    expect(rows[0]?.displayedAt).toBeNull();
  });

  it("records displayed and clicked independently", async () => {
    const { cookie, participantId, sessionId } = await enrol();
    await seedAttempt(participantId, sessionId);

    for (const event of ["DISPLAYED", "CLICKED"]) {
      await participant(cookie)
        .post("/api/participant/notifications/events", {
          sessionId,
          kind: "INITIAL",
          occurrenceIndex: 0,
          event,
        })
        .expect(204);
    }

    const rows = await harness.db.select().from(notificationAttempts);
    expect(rows[0]?.displayedAt).not.toBeNull();
    expect(rows[0]?.clickedAt).not.toBeNull();
  });

  it("refuses a report for another participant's attempt", async () => {
    // The client supplies the session id from a push payload. Trusting it and
    // checking ownership afterwards would let anyone holding one stamp
    // "clicked" onto somebody else's record.
    const first = await enrol();
    const second = await enrol();
    await seedAttempt(first.participantId, first.sessionId);

    await participant(second.cookie)
      .post("/api/participant/notifications/events", {
        sessionId: first.sessionId,
        kind: "INITIAL",
        occurrenceIndex: 0,
        event: "CLICKED",
      })
      .expect(404);

    const rows = await harness.db.select().from(notificationAttempts);
    expect(rows[0]?.clickedAt).toBeNull();
  });

  it("answers an unknown attempt exactly as it answers someone else's", async () => {
    const first = await enrol();
    const second = await enrol();
    await seedAttempt(first.participantId, first.sessionId);

    const theirs = await participant(second.cookie)
      .post("/api/participant/notifications/events", {
        sessionId: first.sessionId,
        kind: "INITIAL",
        occurrenceIndex: 0,
        event: "CLICKED",
      })
      .expect(404);

    const nonexistent = await participant(second.cookie)
      .post("/api/participant/notifications/events", {
        sessionId: second.sessionId,
        kind: "REMINDER",
        occurrenceIndex: 7,
        event: "CLICKED",
      })
      .expect(404);

    // Identical. Otherwise a caller could learn that somebody else was notified
    // about a session they happen to hold an id for.
    expect(theirs.body).toEqual(nonexistent.body);
  });

  it("needs a credential", async () => {
    await request(server())
      .post("/api/participant/notifications/events")
      .set("Origin", PARTICIPANT_ORIGIN)
      .send({
        sessionId: crypto.randomUUID(),
        kind: "INITIAL",
        occurrenceIndex: 0,
        event: "CLICKED",
      })
      .expect(401);
  });
});

describe("notification history", () => {
  it("shows what was sent, newest first", async () => {
    const { cookie, participantId, sessionId } = await enrol();
    await seedAttempt(participantId, sessionId, {
      kind: "INITIAL",
      occurrenceIndex: 0,
      scheduledFor: new Date(Date.now() - 7_200_000),
    });
    await seedAttempt(participantId, sessionId, {
      kind: "REMINDER",
      occurrenceIndex: 1,
      scheduledFor: new Date(Date.now() - 3_600_000),
    });

    const response = await participant(cookie).get("/api/participant/notifications").expect(200);

    expect(response.body.attempts).toHaveLength(2);
    expect(response.body.attempts[0].kind).toBe("REMINDER");
    expect(response.body.attempts[1].kind).toBe("INITIAL");
  });

  it("includes suppressions with their reason", async () => {
    // A gap is unanswerable. "We did not remind you because you had already
    // finished" is both true and reassuring, and it is why the reason column
    // exists at all.
    const { cookie, participantId, sessionId } = await enrol();
    await seedAttempt(participantId, sessionId, {
      kind: "REMINDER",
      occurrenceIndex: 1,
      outcome: "SUPPRESSED",
      suppressionReason: "SUPPRESSED_STATE",
      attemptedAt: null,
    });

    const response = await participant(cookie).get("/api/participant/notifications").expect(200);

    expect(response.body.attempts[0]).toMatchObject({
      outcome: "SUPPRESSED",
      suppressionReason: "SUPPRESSED_STATE",
      attemptedAt: null,
    });
  });

  it("shows a participant only their own record", async () => {
    const first = await enrol();
    const second = await enrol();
    await seedAttempt(first.participantId, first.sessionId);

    const theirs = await participant(second.cookie)
      .get("/api/participant/notifications")
      .expect(200);

    expect(theirs.body.attempts).toEqual([]);
  });

  it("never exposes a push endpoint or a subscription id", async () => {
    // The endpoint is a capability URL that wakes a device (STRUCTURE.md
    // §11.1). It lives in the identity schema and has no business travelling to
    // a client, not even the participant's own.
    const { cookie, participantId, sessionId } = await enrol();
    await seedAttempt(participantId, sessionId, {
      pushSubscriptionId: crypto.randomUUID(),
    });

    const response = await participant(cookie).get("/api/participant/notifications").expect(200);

    const body = JSON.stringify(response.body);
    expect(body).not.toContain("pushSubscriptionId");
    expect(body).not.toContain("endpoint");
  });
});

describe("the duplicate-reminder guard, at the database", () => {
  it("refuses a second attempt for the same session, kind and occurrence", async () => {
    // The unique index is the real guarantee behind every other protection
    // against notifying a participant twice (STRUCTURE.md §6).
    const { participantId, sessionId } = await enrol();
    await seedAttempt(participantId, sessionId);

    await expect(seedAttempt(participantId, sessionId)).rejects.toThrow();
  });

  it("allows the same occurrence index for a different kind", async () => {
    // INITIAL:0 and REMINDER:0 would be a strange chain, but the constraint is
    // on the triple and must not over-reach into forbidding it.
    const { participantId, sessionId } = await enrol();
    await seedAttempt(participantId, sessionId, { kind: "INITIAL", occurrenceIndex: 0 });

    await expect(
      seedAttempt(participantId, sessionId, { kind: "REMINDER", occurrenceIndex: 0 }),
    ).resolves.toBeUndefined();
  });

  it("refuses a suppression with no reason", async () => {
    // A suppression that does not say which guard fired is indistinguishable
    // from a participant who ignored us — precisely the confusion the column
    // exists to prevent.
    const { participantId, sessionId } = await enrol();

    await expect(
      seedAttempt(participantId, sessionId, {
        outcome: "SUPPRESSED",
        attemptedAt: null,
        suppressionReason: null,
      }),
    ).rejects.toThrow();
  });

  it("refuses a suppression that claims to have been attempted", async () => {
    const { participantId, sessionId } = await enrol();

    await expect(
      seedAttempt(participantId, sessionId, {
        outcome: "SUPPRESSED",
        suppressionReason: "SUPPRESSED_CAP",
        attemptedAt: new Date(),
      }),
    ).rejects.toThrow();
  });
});
