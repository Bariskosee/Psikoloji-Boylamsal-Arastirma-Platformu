import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { participantSessions, responseHistory, sessionSubmissions } from "@lpr/db";
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
 * Phase 6's acceptance criteria against a real PostgreSQL.
 *
 * The hard ones are concurrency and time: ten simultaneous completions must
 * produce exactly one submission, and an expired session must refuse writes no
 * matter what the client believes the time is.
 *
 * Sessions are inserted directly here — Phase 6 has no engine to create them,
 * which is what PLAN.md means by "created manually via test fixtures".
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

interface Fixture {
  cookie: string;
  sessionId: string;
  questionIds: { required: string; optional: string };
  optionIds: string[];
}

/**
 * A study with a two-question questionnaire, an enrolled participant, and one
 * open session.
 */
async function openSession(window?: { from: Date; until: Date }): Promise<Fixture> {
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
  await client.post(`/api/studies/${studyId}/consent/publish`).expect(201);

  const questionnaire = await client
    .post(`/api/studies/${studyId}/questionnaires`, { name: "daily", description: "" })
    .expect(201);
  const qid: string = questionnaire.body.id;

  const required = await client
    .post(`/api/studies/${studyId}/questionnaires/${qid}/questions`, {
      type: "SINGLE_CHOICE",
      translations: { en: "Sample question 1", tr: "Örnek soru 1" },
    })
    .expect(201);
  for (const label of ["Sample option A", "Sample option B"]) {
    await client
      .post(`/api/studies/${studyId}/questionnaires/${qid}/questions/${required.body.id}/options`, {
        translations: { en: label, tr: label },
      })
      .expect(201);
  }

  const optional = await client
    .post(`/api/studies/${studyId}/questionnaires/${qid}/questions`, {
      type: "FREE_TEXT",
      translations: { en: "Sample question 2", tr: "Örnek soru 2" },
      isRequired: false,
    })
    .expect(201);

  const publishedQuestionnaire = await client
    .post(`/api/studies/${studyId}/questionnaires/${qid}/publish`)
    .expect(201);

  const protocol = await client
    .post(`/api/studies/${studyId}/protocols`, { name: "main", description: "" })
    .expect(201);
  await client
    .post(`/api/studies/${studyId}/protocols/${protocol.body.id}/steps`, {
      stepKey: "daily",
      questionnaireVersionId: publishedQuestionnaire.body.id,
      triggerType: "ENROLLMENT",
      windowDurationIso: "P1D",
    })
    .expect(201);
  const publishedProtocol = await client
    .post(`/api/studies/${studyId}/protocols/${protocol.body.id}/publish`)
    .expect(201);
  await client.put(`/api/studies/${studyId}/status`, { status: "ACTIVE" }).expect(200);

  const detail = await client.get(`/api/studies/${studyId}`).expect(200);
  const consent = await request(server())
    .get(`/api/participant/studies/${detail.body.enrollmentCode}`)
    .expect(200);

  const enrolled = await post(`/api/participant/studies/${detail.body.enrollmentCode}/enroll`)
    .send({
      consentVersionId: consent.body.consent.versionId,
      consented: true,
      consentLocale: "en",
      locale: "en",
      timezone: "Europe/Istanbul",
    })
    .expect(201);

  const raw = enrolled.headers["set-cookie"] as unknown as string[];
  const cookie =
    (raw.find((v) => v.startsWith(`${PARTICIPANT_COOKIE_NAME}=`)) ?? "").split(";")[0] ?? "";

  // The published step and its questions, which is what a session references.
  const stepRow = await harness.db.execute(
    `select id from research.protocol_steps where protocol_version_id = '${publishedProtocol.body.id}'` as never,
  );
  const stepId = (stepRow as unknown as { rows: { id: string }[] }).rows[0]?.id ?? "";

  const publishedQuestions = await harness.db.execute(
    `select id, is_required from research.question_versions
      where questionnaire_version_id = '${publishedQuestionnaire.body.id}'
      order by display_order` as never,
  );
  const qrows = (publishedQuestions as unknown as { rows: { id: string; is_required: boolean }[] })
    .rows;

  const optionRows = await harness.db.execute(
    `select id from research.question_options where question_version_id = '${qrows[0]?.id ?? ""}' order by display_order` as never,
  );
  const optionIds = (optionRows as unknown as { rows: { id: string }[] }).rows.map((r) => r.id);

  // Resolved by the public code THIS enrollment returned. A `limit 1` here
  // would hand every fixture the first participant ever created, and the
  // ownership test would then be checking one participant against themselves.
  const participantRow = await harness.db.execute(
    `select id from research.participants where public_code = '${enrolled.body.publicCode as string}'` as never,
  );
  const participantId = (participantRow as unknown as { rows: { id: string }[] }).rows[0]?.id ?? "";

  /**
   * The session already exists.
   *
   * Phase 6 inserted one by hand — PLAN.md called that "created manually via
   * test fixtures" — but Phase 7's engine materialises it during enrollment,
   * and a second insert now collides on the (participant, step, occurrence)
   * unique index. Adjusting the materialised row instead is also the better
   * test: the runtime is exercised against a session the engine produced.
   */
  const from = window?.from ?? new Date(Date.now() - 60_000);
  const until = window?.until ?? new Date(Date.now() + 3_600_000);

  const materialised = await harness.db
    .update(participantSessions)
    .set({ status: "AVAILABLE", availableFrom: from, availableUntil: until })
    .where(eq(participantSessions.participantId, participantId))
    .returning();

  void optional;
  void stepId;
  return {
    cookie,
    sessionId: materialised[0]?.id ?? "",
    questionIds: { required: qrows[0]?.id ?? "", optional: qrows[1]?.id ?? "" },
    optionIds,
  };
}

describe("reading a session", () => {
  it("returns the questions, in the participant's language, with the server's clock", async () => {
    const fixture = await openSession();

    const response = await request(server())
      .get(`/api/participant/sessions/${fixture.sessionId}`)
      .set("Cookie", fixture.cookie)
      .expect(200);

    expect(response.body.questions).toHaveLength(2);
    expect(response.body.questions[0].text).toBe("Sample question 1");
    expect(response.body.questions[0].options).toHaveLength(2);
    // The interface must be able to show a truthful countdown without trusting
    // the device clock.
    expect(new Date(response.body.serverTime).getTime()).toBeGreaterThan(0);
  });

  it("refuses another participant's session", async () => {
    const mine = await openSession();
    const theirs = await openSession();

    await request(server())
      .get(`/api/participant/sessions/${theirs.sessionId}`)
      .set("Cookie", mine.cookie)
      .expect(404);
  });

  it("refuses an unauthenticated caller", async () => {
    const fixture = await openSession();

    await request(server()).get(`/api/participant/sessions/${fixture.sessionId}`).expect(401);
  });
});

describe("autosave", () => {
  it("stores an answer and starts the session", async () => {
    const fixture = await openSession();

    const response = await post(`/api/participant/sessions/${fixture.sessionId}/answers`)
      .set("Cookie", fixture.cookie)
      .send({
        answers: [
          {
            questionVersionId: fixture.questionIds.required,
            clientRevision: 1,
            selectedOptionIds: [fixture.optionIds[0]],
          },
        ],
      })
      .expect(200);

    expect(response.body.results[0].outcome).toBe("APPLY");
    expect(response.body.status).toBe("STARTED");
  });

  it("treats a retry of the same revision as a duplicate, not an error", async () => {
    // An outbox that cannot tell whether its request arrived will send it
    // again; failing would leave it unable to drain.
    const fixture = await openSession();
    const body = {
      answers: [
        {
          questionVersionId: fixture.questionIds.required,
          clientRevision: 1,
          selectedOptionIds: [fixture.optionIds[0]],
        },
      ],
    };

    await post(`/api/participant/sessions/${fixture.sessionId}/answers`)
      .set("Cookie", fixture.cookie)
      .send(body)
      .expect(200);
    const second = await post(`/api/participant/sessions/${fixture.sessionId}/answers`)
      .set("Cookie", fixture.cookie)
      .send(body)
      .expect(200);

    expect(second.body.results[0].outcome).toBe("IGNORE_DUPLICATE");
  });

  it("ignores a stale revision rather than resurrecting an old answer", async () => {
    const fixture = await openSession();

    await post(`/api/participant/sessions/${fixture.sessionId}/answers`)
      .set("Cookie", fixture.cookie)
      .send({
        answers: [
          {
            questionVersionId: fixture.questionIds.required,
            clientRevision: 5,
            selectedOptionIds: [fixture.optionIds[1]],
          },
        ],
      })
      .expect(200);

    const stale = await post(`/api/participant/sessions/${fixture.sessionId}/answers`)
      .set("Cookie", fixture.cookie)
      .send({
        answers: [
          {
            questionVersionId: fixture.questionIds.required,
            clientRevision: 2,
            selectedOptionIds: [fixture.optionIds[0]],
          },
        ],
      })
      .expect(200);

    expect(stale.body.results[0].outcome).toBe("IGNORE_STALE");

    const detail = await request(server())
      .get(`/api/participant/sessions/${fixture.sessionId}`)
      .set("Cookie", fixture.cookie)
      .expect(200);
    // The later answer survives.
    expect(detail.body.answers[0].selectedOptionIds).toEqual([fixture.optionIds[1]]);
  });

  it("records both the winning and the losing write in history", async () => {
    // The history exists to answer "what did the client send and what did we
    // do with it" — keeping only the winners would prove nothing.
    const fixture = await openSession();

    for (const revision of [5, 2]) {
      await post(`/api/participant/sessions/${fixture.sessionId}/answers`)
        .set("Cookie", fixture.cookie)
        .send({
          answers: [
            {
              questionVersionId: fixture.questionIds.required,
              clientRevision: revision,
              selectedOptionIds: [fixture.optionIds[0]],
            },
          ],
        })
        .expect(200);
    }

    const rows = await harness.db
      .select()
      .from(responseHistory)
      .where(eq(responseHistory.sessionId, fixture.sessionId));

    expect(rows.map((row) => row.outcome).sort()).toEqual(["APPLY", "IGNORE_STALE"]);
  });

  it("rejects an option that belongs to a different question", async () => {
    const fixture = await openSession();
    const other = await openSession();

    await post(`/api/participant/sessions/${fixture.sessionId}/answers`)
      .set("Cookie", fixture.cookie)
      .send({
        answers: [
          {
            questionVersionId: fixture.questionIds.required,
            clientRevision: 1,
            selectedOptionIds: [other.optionIds[0]],
          },
        ],
      })
      .expect(400);
  });

  it("replays a mixed batch, applying the new and ignoring the known", async () => {
    const fixture = await openSession();

    await post(`/api/participant/sessions/${fixture.sessionId}/answers`)
      .set("Cookie", fixture.cookie)
      .send({
        answers: [
          {
            questionVersionId: fixture.questionIds.required,
            clientRevision: 1,
            selectedOptionIds: [fixture.optionIds[0]],
          },
        ],
      })
      .expect(200);

    const replay = await post(`/api/participant/sessions/${fixture.sessionId}/answers`)
      .set("Cookie", fixture.cookie)
      .send({
        answers: [
          {
            questionVersionId: fixture.questionIds.required,
            clientRevision: 1,
            selectedOptionIds: [fixture.optionIds[0]],
          },
          {
            questionVersionId: fixture.questionIds.optional,
            clientRevision: 1,
            valueText: "Sample free text",
          },
        ],
      })
      .expect(200);

    expect(replay.body.results.map((r: { outcome: string }) => r.outcome)).toEqual([
      "IGNORE_DUPLICATE",
      "APPLY",
    ]);
  });
});

describe("the response window is the server's to decide", () => {
  it("refuses a write to a session whose window has passed", async () => {
    const past = {
      from: new Date(Date.now() - 7_200_000),
      until: new Date(Date.now() - 3_600_000),
    };
    const fixture = await openSession(past);

    const refused = await post(`/api/participant/sessions/${fixture.sessionId}/answers`)
      .set("Cookie", fixture.cookie)
      .send({
        answers: [
          {
            questionVersionId: fixture.questionIds.required,
            clientRevision: 1,
            selectedOptionIds: [fixture.optionIds[0]],
          },
        ],
      })
      .expect(409);

    expect(refused.body.error.code).toBe("SESSION_WINDOW_CLOSED");
  });

  it("refuses even when the session is still labelled AVAILABLE", async () => {
    // A sweeper may not have relabelled it yet (ADR-005). Deciding on the
    // stored timestamps means a late sweep delays bookkeeping, not correctness.
    const past = {
      from: new Date(Date.now() - 7_200_000),
      until: new Date(Date.now() - 3_600_000),
    };
    const fixture = await openSession(past);

    const row = await harness.db
      .select()
      .from(participantSessions)
      .where(eq(participantSessions.id, fixture.sessionId));
    expect(row[0]?.status).toBe("AVAILABLE");

    await post(`/api/participant/sessions/${fixture.sessionId}/complete`)
      .set("Cookie", fixture.cookie)
      .expect(409);
  });

  it("refuses a write before the window opens", async () => {
    const future = {
      from: new Date(Date.now() + 3_600_000),
      until: new Date(Date.now() + 7_200_000),
    };
    const fixture = await openSession(future);

    const refused = await post(`/api/participant/sessions/${fixture.sessionId}/answers`)
      .set("Cookie", fixture.cookie)
      .send({
        answers: [
          {
            questionVersionId: fixture.questionIds.required,
            clientRevision: 1,
            selectedOptionIds: [fixture.optionIds[0]],
          },
        ],
      })
      .expect(409);

    expect(refused.body.error.code).toBe("SESSION_NOT_AVAILABLE");
  });
});

describe("completion", () => {
  async function answerRequired(fixture: Fixture): Promise<void> {
    await post(`/api/participant/sessions/${fixture.sessionId}/answers`)
      .set("Cookie", fixture.cookie)
      .send({
        answers: [
          {
            questionVersionId: fixture.questionIds.required,
            clientRevision: 1,
            selectedOptionIds: [fixture.optionIds[0]],
          },
        ],
      })
      .expect(200);
  }

  it("refuses while a required question is unanswered, naming it", async () => {
    const fixture = await openSession();

    const refused = await post(`/api/participant/sessions/${fixture.sessionId}/complete`)
      .set("Cookie", fixture.cookie)
      .expect(409);

    expect(refused.body.error.code).toBe("REQUIRED_QUESTIONS_UNANSWERED");
    expect(refused.body.error.details).toHaveLength(1);
  });

  it("does not count a blank answer as answering a required question", async () => {
    const fixture = await openSession();

    // A valid write that clears the answer — but not a response.
    await post(`/api/participant/sessions/${fixture.sessionId}/answers`)
      .set("Cookie", fixture.cookie)
      .send({
        answers: [
          {
            questionVersionId: fixture.questionIds.required,
            clientRevision: 1,
            selectedOptionIds: [],
          },
        ],
      })
      .expect(200);

    await post(`/api/participant/sessions/${fixture.sessionId}/complete`)
      .set("Cookie", fixture.cookie)
      .expect(409);
  });

  it("completes once every required question is answered", async () => {
    const fixture = await openSession();
    await answerRequired(fixture);

    const completed = await post(`/api/participant/sessions/${fixture.sessionId}/complete`)
      .set("Cookie", fixture.cookie)
      .expect(200);

    expect(completed.body.alreadyCompleted).toBe(false);
    expect(completed.body.answeredCount).toBe(1);
    expect(completed.body.requiredCount).toBe(1);
  });

  it("produces exactly one submission under ten concurrent calls", async () => {
    // The acceptance criterion. The row lock serialises them; the unique index
    // on session_id is what makes the guarantee independent of the lock.
    const fixture = await openSession();
    await answerRequired(fixture);

    const attempts = await Promise.all(
      Array.from({ length: 10 }, () =>
        post(`/api/participant/sessions/${fixture.sessionId}/complete`).set(
          "Cookie",
          fixture.cookie,
        ),
      ),
    );

    expect(attempts.every((response) => response.status === 200)).toBe(true);
    expect(attempts.filter((r) => r.body.alreadyCompleted === false)).toHaveLength(1);

    const submissions = await harness.db
      .select()
      .from(sessionSubmissions)
      .where(eq(sessionSubmissions.sessionId, fixture.sessionId));
    expect(submissions).toHaveLength(1);
  });

  it("refuses further writes once completed", async () => {
    const fixture = await openSession();
    await answerRequired(fixture);
    await post(`/api/participant/sessions/${fixture.sessionId}/complete`)
      .set("Cookie", fixture.cookie)
      .expect(200);

    const refused = await post(`/api/participant/sessions/${fixture.sessionId}/answers`)
      .set("Cookie", fixture.cookie)
      .send({
        answers: [
          {
            questionVersionId: fixture.questionIds.required,
            clientRevision: 99,
            selectedOptionIds: [fixture.optionIds[1]],
          },
        ],
      })
      .expect(409);

    expect(refused.body.error.code).toBe("SESSION_ALREADY_COMPLETED");
  });

  it("records a content hash of exactly what was submitted", async () => {
    const fixture = await openSession();
    await answerRequired(fixture);
    await post(`/api/participant/sessions/${fixture.sessionId}/complete`)
      .set("Cookie", fixture.cookie)
      .expect(200);

    const submission = (
      await harness.db
        .select()
        .from(sessionSubmissions)
        .where(eq(sessionSubmissions.sessionId, fixture.sessionId))
    )[0];

    expect(submission?.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("saved answers survive the client disappearing", () => {
  it("restores exactly the answers the server acknowledged", async () => {
    // The E2E criterion, at the API level: nothing is kept client-side that the
    // restore depends on.
    const fixture = await openSession();

    await post(`/api/participant/sessions/${fixture.sessionId}/answers`)
      .set("Cookie", fixture.cookie)
      .send({
        answers: [
          {
            questionVersionId: fixture.questionIds.required,
            clientRevision: 3,
            selectedOptionIds: [fixture.optionIds[1]],
          },
          {
            questionVersionId: fixture.questionIds.optional,
            clientRevision: 1,
            valueText: "Sample free text",
          },
        ],
      })
      .expect(200);

    const reopened = await request(server())
      .get(`/api/participant/sessions/${fixture.sessionId}`)
      .set("Cookie", fixture.cookie)
      .expect(200);

    const byQuestion = new Map(
      reopened.body.answers.map((a: { questionVersionId: string }) => [a.questionVersionId, a]),
    );
    expect(byQuestion.get(fixture.questionIds.required)).toMatchObject({
      selectedOptionIds: [fixture.optionIds[1]],
      clientRevision: 3,
    });
    expect(byQuestion.get(fixture.questionIds.optional)).toMatchObject({
      valueText: "Sample free text",
    });
  });
});
