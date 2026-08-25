import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { participantSessions } from "@lpr/db";
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
 * The scheduling engine, end to end (PLAN.md Phase 7).
 *
 * Enrolling on the reference protocol must materialise exactly 32 sessions at
 * the instants `docs/reference-protocol.md` §6 tabulates, and completing a step
 * must schedule what depends on it without any manual intervention.
 *
 * The times asserted here are relative to the enrollment instant, because the
 * API's clock is real. The absolute-instant assertions against the reference
 * table live in the domain suite, where a fixture clock makes them exact.
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
const post = (path: string) => request(server()).post(path).set("Origin", PARTICIPANT_ORIGIN);

interface Built {
  client: Client;
  studyId: string;
  code: string;
  consentVersionId: string;
  questionnaireVersionId: string;
}

/** A study with one published questionnaire, ready for a protocol. */
async function study(): Promise<Built> {
  const owner = await createUser(harness.db);
  const client = await Client.login(harness.app, owner);
  const created = await client.post("/api/studies", VALID_STUDY).expect(201);
  const studyId: string = created.body.id;

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
      // Optional on purpose: these tests are about WHEN a session opens, not
      // about required-question validation, which the runtime suite covers.
      isRequired: false,
    })
    .expect(201);
  const published = await client
    .post(`/api/studies/${studyId}/questionnaires/${questionnaire.body.id}/publish`)
    .expect(201);

  const detail = await client.get(`/api/studies/${studyId}`).expect(200);

  return {
    client,
    studyId,
    code: detail.body.enrollmentCode,
    consentVersionId: consent.body.id,
    questionnaireVersionId: published.body.id,
  };
}

async function enroll(built: Built): Promise<{ cookie: string; publicCode: string }> {
  await activate(built);

  const consent = await request(server()).get(`/api/participant/studies/${built.code}`).expect(200);

  const enrolled = await post(`/api/participant/studies/${built.code}/enroll`)
    .send({
      consentVersionId: consent.body.consent.versionId,
      consented: true,
      consentLocale: "en",
      locale: "en",
      timezone: "Europe/Istanbul",
    })
    .expect(201);

  const raw = enrolled.headers["set-cookie"] as unknown as string[];
  return {
    cookie:
      (raw.find((v) => v.startsWith(`${PARTICIPANT_COOKIE_NAME}=`)) ?? "").split(";")[0] ?? "",
    publicCode: enrolled.body.publicCode,
  };
}

/**
 * Open the study for enrollment, once.
 *
 * `ACTIVE → ACTIVE` is not a legal transition, so a test enrolling twice would
 * otherwise fail on the study's lifecycle rather than on anything it is about.
 */
async function activate(built: Built): Promise<void> {
  const detail = await built.client.get(`/api/studies/${built.studyId}`).expect(200);
  if (detail.body.status === "ACTIVE") return;
  await built.client.put(`/api/studies/${built.studyId}/status`, { status: "ACTIVE" }).expect(200);
}

/** The reference protocol: baseline, a thirty-occurrence block, an endline. */
async function referenceProtocol(built: Built): Promise<void> {
  const protocol = await built.client
    .post(`/api/studies/${built.studyId}/protocols`, { name: "main", description: "" })
    .expect(201);
  const id: string = protocol.body.id;
  const start = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

  await built.client
    .post(`/api/studies/${built.studyId}/protocols/${id}/steps`, {
      stepKey: "baseline",
      questionnaireVersionId: built.questionnaireVersionId,
      triggerType: "ENROLLMENT",
      windowDurationIso: "P3D",
    })
    .expect(201);
  await built.client
    .post(`/api/studies/${built.studyId}/protocols/${id}/steps`, {
      stepKey: "daily",
      questionnaireVersionId: built.questionnaireVersionId,
      triggerType: "FIXED_DATETIME",
      triggerFixedDate: start,
      anchorLocalTime: "20:00",
      anchorTimezoneSource: "PARTICIPANT",
      windowDurationIso: "PT12H",
      occurrenceCount: 30,
      recurrenceIntervalIso: "P1D",
    })
    .expect(201);
  await built.client
    .post(`/api/studies/${built.studyId}/protocols/${id}/steps`, {
      stepKey: "endline",
      questionnaireVersionId: built.questionnaireVersionId,
      triggerType: "FIXED_DATETIME",
      triggerFixedDate: start,
      offsetIso: "P30D",
      anchorLocalTime: "20:00",
      anchorTimezoneSource: "PARTICIPANT",
      windowDurationIso: "P3D",
    })
    .expect(201);

  await built.client.post(`/api/studies/${built.studyId}/protocols/${id}/publish`).expect(201);
}

async function sessionsOf(publicCode: string) {
  const participant = await harness.db.execute(
    `select id from research.participants where public_code = '${publicCode}'` as never,
  );
  const participantId = (participant as unknown as { rows: { id: string }[] }).rows[0]?.id ?? "";
  return harness.db
    .select()
    .from(participantSessions)
    .where(eq(participantSessions.participantId, participantId));
}

describe("materialisation on enrollment", () => {
  it("creates exactly 32 sessions in one transaction", async () => {
    // The acceptance criterion: 1 baseline + 30 daily + 1 endline.
    const built = await study();
    await referenceProtocol(built);
    const { publicCode } = await enroll(built);

    expect(await sessionsOf(publicCode)).toHaveLength(32);
  });

  it("opens the baseline immediately and schedules the rest", async () => {
    const built = await study();
    await referenceProtocol(built);
    const { publicCode } = await enroll(built);

    const sessions = await sessionsOf(publicCode);
    const statuses = sessions.reduce<Record<string, number>>((counts, session) => {
      counts[session.status] = (counts[session.status] ?? 0) + 1;
      return counts;
    }, {});

    expect(statuses["AVAILABLE"]).toBe(1);
    expect(statuses["SCHEDULED"]).toBe(31);
  });

  it("places the daily block one day apart", async () => {
    const built = await study();
    await referenceProtocol(built);
    const { publicCode } = await enroll(built);

    const sessions = await sessionsOf(publicCode);
    const block = sessions
      .filter((session) => session.occurrenceIndex > 0 || session.availableUntil !== null)
      .filter((session) => session.occurrenceIndex >= 0)
      .sort((a, b) => (a.availableFrom?.getTime() ?? 0) - (b.availableFrom?.getTime() ?? 0));

    const daily = block.filter((session) => {
      const window =
        (session.availableUntil?.getTime() ?? 0) - (session.availableFrom?.getTime() ?? 0);
      return window === 12 * 3_600_000;
    });

    expect(daily).toHaveLength(30);
    const first = daily[0]?.availableFrom?.getTime() ?? 0;
    const second = daily[1]?.availableFrom?.getTime() ?? 0;
    expect(second - first).toBe(86_400_000);
  });

  it("gives the participant their sessions through the API", async () => {
    const built = await study();
    await referenceProtocol(built);
    const { cookie } = await enroll(built);

    const listed = await request(server())
      .get("/api/participant/sessions")
      .set("Cookie", cookie)
      .expect(200);

    expect(listed.body.sessions).toHaveLength(32);
    expect(
      listed.body.sessions.filter((s: { status: string }) => s.status === "AVAILABLE"),
    ).toHaveLength(1);
  });

  it("gives two participants enrolling apart independent, correct timelines", async () => {
    const built = await study();
    await referenceProtocol(built);

    const first = await enroll(built);
    const second = await enroll(built);

    const firstSessions = await sessionsOf(first.publicCode);
    const secondSessions = await sessionsOf(second.publicCode);

    expect(firstSessions).toHaveLength(32);
    expect(secondSessions).toHaveLength(32);
    // The cohort block is shared — that is what a fixed date means — while the
    // enrollment-anchored baseline belongs to each of them.
    expect(
      firstSessions.map((s) => s.id).some((id) => secondSessions.some((s) => s.id === id)),
    ).toBe(false);
  });
});

describe("trigger propagation", () => {
  /** baseline at enrollment, follow-up one day after the baseline COMPLETES. */
  async function chained(built: Built): Promise<void> {
    const protocol = await built.client
      .post(`/api/studies/${built.studyId}/protocols`, { name: "chained", description: "" })
      .expect(201);
    const id: string = protocol.body.id;

    const baseline = await built.client
      .post(`/api/studies/${built.studyId}/protocols/${id}/steps`, {
        stepKey: "baseline",
        questionnaireVersionId: built.questionnaireVersionId,
        triggerType: "ENROLLMENT",
        windowDurationIso: "P3D",
      })
      .expect(201);

    await built.client
      .post(`/api/studies/${built.studyId}/protocols/${id}/steps`, {
        stepKey: "follow_up",
        questionnaireVersionId: built.questionnaireVersionId,
        triggerType: "STEP_COMPLETED",
        triggerStepId: baseline.body.id,
        offsetIso: "P1D",
        windowDurationIso: "P1D",
      })
      .expect(201);

    await built.client.post(`/api/studies/${built.studyId}/protocols/${id}/publish`).expect(201);
  }

  it("materialises a completion-triggered step as PENDING_TRIGGER", async () => {
    const built = await study();
    await chained(built);
    const { publicCode } = await enroll(built);

    const sessions = await sessionsOf(publicCode);
    expect(sessions.filter((s) => s.status === "PENDING_TRIGGER")).toHaveLength(1);
  });

  it("schedules the dependent step when the baseline is completed", async () => {
    // The acceptance criterion: no manual intervention, no job required.
    const built = await study();
    await chained(built);
    const { cookie, publicCode } = await enroll(built);

    const listed = await request(server())
      .get("/api/participant/sessions")
      .set("Cookie", cookie)
      .expect(200);
    const open = listed.body.sessions.find((s: { status: string }) => s.status === "AVAILABLE");

    await post(`/api/participant/sessions/${open.id}/complete`).set("Cookie", cookie).expect(200);

    const sessions = await sessionsOf(publicCode);
    const dependent = sessions.find((s) => s.status === "SCHEDULED");

    expect(dependent).toBeDefined();
    expect(dependent?.availableFrom).not.toBeNull();
    expect(dependent?.triggerFiredAt).not.toBeNull();
    // Placed exactly one day after the completion instant.
    const completed = sessions.find((s) => s.status === "COMPLETED");
    expect(
      (dependent?.availableFrom?.getTime() ?? 0) - (completed?.completedAt?.getTime() ?? 0),
    ).toBe(86_400_000);
  });

  it("leaves the dependent step waiting until the baseline is done", async () => {
    const built = await study();
    await chained(built);
    const { publicCode } = await enroll(built);

    const sessions = await sessionsOf(publicCode);
    const pending = sessions.find((s) => s.status === "PENDING_TRIGGER");
    expect(pending?.availableFrom).toBeNull();
  });
});

describe("withdrawal", () => {
  it("cancels every non-terminal session and leaves the rest", async () => {
    const built = await study();
    await referenceProtocol(built);
    const { cookie, publicCode } = await enroll(built);

    await post("/api/participant/withdraw").set("Cookie", cookie).send({}).expect(204);

    const sessions = await sessionsOf(publicCode);
    expect(sessions).toHaveLength(32);
    expect(sessions.every((s) => s.status === "CANCELLED")).toBe(true);
    expect(sessions.every((s) => s.cancellationReason === "WITHDRAWAL")).toBe(true);
  });

  it("does not cancel a session the participant already completed", async () => {
    // Withdrawal is not erasure: a completed questionnaire is data they gave.
    const built = await study();
    await referenceProtocol(built);
    const { cookie, publicCode } = await enroll(built);

    const listed = await request(server())
      .get("/api/participant/sessions")
      .set("Cookie", cookie)
      .expect(200);
    const open = listed.body.sessions.find((s: { status: string }) => s.status === "AVAILABLE");
    await post(`/api/participant/sessions/${open.id}/complete`).set("Cookie", cookie).expect(200);

    await post("/api/participant/withdraw").set("Cookie", cookie).send({}).expect(204);

    const sessions = await sessionsOf(publicCode);
    const completed = sessions.filter((s) => s.status === "COMPLETED");
    expect(completed).toHaveLength(1);
    expect(sessions.filter((s) => s.status === "CANCELLED")).toHaveLength(31);
  });
});

describe("the schedule is the server's alone", () => {
  it("ignores anything the client says about timing", async () => {
    const built = await study();
    await referenceProtocol(built);

    const consent = await request(server())
      .get(`/api/participant/studies/${built.code}`)
      .expect(200);

    // Extra fields are rejected outright by the strict schema rather than
    // being quietly ignored, so a client cannot even attempt to set a window.
    await activate(built);
    const enrolled = await post(`/api/participant/studies/${built.code}/enroll`)
      .send({
        consentVersionId: consent.body.consent.versionId,
        consented: true,
        consentLocale: "en",
        locale: "en",
        timezone: "Europe/Istanbul",
        availableFrom: "2020-01-01T00:00:00.000Z",
      })
      .expect(201);

    const sessions = await sessionsOf(enrolled.body.publicCode);
    expect(
      sessions.every((s) => (s.availableFrom?.getTime() ?? 0) > Date.parse("2025-01-01")),
    ).toBe(true);
  });
});
