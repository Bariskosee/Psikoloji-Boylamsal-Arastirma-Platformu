import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  Client,
  VALID_STUDY,
  createHarness,
  createUser,
  resetDatabase,
  type Harness,
} from "../../testing/harness.js";

/**
 * Phase 4's acceptance criteria, exercised against a real PostgreSQL.
 *
 * The protocol built throughout is `docs/reference-protocol.md`: a baseline, a
 * thirty-occurrence daily block, and an endline administering the SAME
 * questionnaire version as the baseline. Its hand-computed instants are the
 * assertion target for the preview.
 *
 * Every number here is that study's configuration. None of it may appear in
 * application code (AGENT.md §3.4).
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

/** A study with two published questionnaires: `core` and `daily`. */
async function studyWithInstruments(): Promise<{
  client: Client;
  studyId: string;
  coreVersionId: string;
  dailyVersionId: string;
}> {
  const owner = await createUser(harness.db);
  const client = await Client.login(harness.app, owner);
  const study = await client.post("/api/studies", VALID_STUDY).expect(201);
  const studyId: string = study.body.id;

  const publishQuestionnaire = async (name: string): Promise<string> => {
    const created = await client
      .post(`/api/studies/${studyId}/questionnaires`, { name, description: "" })
      .expect(201);
    const questionnaireId: string = created.body.id;

    const question = await client
      .post(`/api/studies/${studyId}/questionnaires/${questionnaireId}/questions`, {
        type: "SINGLE_CHOICE",
        translations: { en: "Sample question", tr: "Örnek soru" },
      })
      .expect(201);

    for (const label of ["Sample option 1", "Sample option 2"]) {
      await client
        .post(
          `/api/studies/${studyId}/questionnaires/${questionnaireId}/questions/${question.body.id}/options`,
          { translations: { en: label, tr: label } },
        )
        .expect(201);
    }

    const published = await client
      .post(`/api/studies/${studyId}/questionnaires/${questionnaireId}/publish`)
      .expect(201);
    return published.body.id;
  };

  return {
    client,
    studyId,
    coreVersionId: await publishQuestionnaire("core"),
    dailyVersionId: await publishQuestionnaire("daily"),
  };
}

/** The reference protocol in mode A, ready to publish. */
async function referenceProtocol(): Promise<{
  client: Client;
  studyId: string;
  protocolId: string;
  coreVersionId: string;
}> {
  const { client, studyId, coreVersionId, dailyVersionId } = await studyWithInstruments();

  const protocol = await client
    .post(`/api/studies/${studyId}/protocols`, { name: "main", description: "" })
    .expect(201);
  const protocolId: string = protocol.body.id;

  await client
    .post(`/api/studies/${studyId}/protocols/${protocolId}/steps`, {
      stepKey: "baseline",
      questionnaireVersionId: coreVersionId,
      triggerType: "ENROLLMENT",
      offsetIso: "PT0S",
      windowDurationIso: "P3D",
    })
    .expect(201);

  await client
    .post(`/api/studies/${studyId}/protocols/${protocolId}/steps`, {
      stepKey: "daily",
      questionnaireVersionId: dailyVersionId,
      triggerType: "FIXED_DATETIME",
      triggerFixedDate: "2026-09-07",
      offsetIso: "PT0S",
      anchorLocalTime: "20:00",
      anchorTimezoneSource: "PARTICIPANT",
      windowDurationIso: "PT12H",
      occurrenceCount: 30,
      recurrenceIntervalIso: "P1D",
    })
    .expect(201);

  await client
    .post(`/api/studies/${studyId}/protocols/${protocolId}/steps`, {
      // The SAME questionnaire version as the baseline (FR-47).
      stepKey: "endline",
      questionnaireVersionId: coreVersionId,
      triggerType: "FIXED_DATETIME",
      triggerFixedDate: "2026-09-07",
      offsetIso: "P30D",
      anchorLocalTime: "20:00",
      anchorTimezoneSource: "PARTICIPANT",
      windowDurationIso: "P3D",
    })
    .expect(201);

  return { client, studyId, protocolId, coreVersionId };
}

describe("building and publishing the reference protocol", () => {
  it("publishes three steps as version 1", async () => {
    const { client, studyId, protocolId } = await referenceProtocol();

    const published = await client
      .post(`/api/studies/${studyId}/protocols/${protocolId}/publish`)
      .expect(201);

    expect(published.body.status).toBe("PUBLISHED");
    expect(published.body.versionNumber).toBe(1);
    expect(published.body.steps).toHaveLength(3);
  });

  it("administers one questionnaire version at two steps (FR-47)", async () => {
    const { client, studyId, protocolId, coreVersionId } = await referenceProtocol();

    const published = await client
      .post(`/api/studies/${studyId}/protocols/${protocolId}/publish`)
      .expect(201);

    const using = published.body.steps.filter(
      (step: { questionnaireVersionId: string }) => step.questionnaireVersionId === coreVersionId,
    );
    expect(using.map((step: { stepKey: string }) => step.stepKey).sort()).toEqual([
      "baseline",
      "endline",
    ]);
  });

  it("leaves version 1 unchanged after the draft is edited and republished", async () => {
    const { client, studyId, protocolId } = await referenceProtocol();

    const v1 = await client
      .post(`/api/studies/${studyId}/protocols/${protocolId}/publish`)
      .expect(201);
    const before = await client
      .get(`/api/studies/${studyId}/protocols/${protocolId}/versions/${v1.body.id}`)
      .expect(200);

    // Edit the draft: shorten the daily window.
    const detail = await client.get(`/api/studies/${studyId}/protocols/${protocolId}`).expect(200);
    const daily = detail.body.draft.steps.find(
      (step: { stepKey: string }) => step.stepKey === "daily",
    );
    await client
      .patch(`/api/studies/${studyId}/protocols/${protocolId}/steps/${daily.id}`, {
        windowDurationIso: "PT6H",
      })
      .expect(200);

    const v2 = await client
      .post(`/api/studies/${studyId}/protocols/${protocolId}/publish`)
      .expect(201);
    expect(v2.body.versionNumber).toBe(2);

    const after = await client
      .get(`/api/studies/${studyId}/protocols/${protocolId}/versions/${v1.body.id}`)
      .expect(200);
    expect(after.body).toEqual(before.body);
  });

  it("rewrites trigger references onto the copied steps, not the draft's", async () => {
    // A published version that referenced draft rows would depend on steps
    // still being edited.
    const { client, studyId, coreVersionId, dailyVersionId } = await studyWithInstruments();
    const protocol = await client
      .post(`/api/studies/${studyId}/protocols`, { name: "chained", description: "" })
      .expect(201);
    const protocolId: string = protocol.body.id;

    const baseline = await client
      .post(`/api/studies/${studyId}/protocols/${protocolId}/steps`, {
        stepKey: "baseline",
        questionnaireVersionId: coreVersionId,
        triggerType: "ENROLLMENT",
        windowDurationIso: "P3D",
      })
      .expect(201);

    await client
      .post(`/api/studies/${studyId}/protocols/${protocolId}/steps`, {
        stepKey: "follow_up",
        questionnaireVersionId: dailyVersionId,
        triggerType: "STEP_COMPLETED",
        triggerStepId: baseline.body.id,
        offsetIso: "P1D",
        windowDurationIso: "P1D",
      })
      .expect(201);

    const published = await client
      .post(`/api/studies/${studyId}/protocols/${protocolId}/publish`)
      .expect(201);

    const publishedIds = new Set(published.body.steps.map((step: { id: string }) => step.id));
    const followUp = published.body.steps.find(
      (step: { stepKey: string }) => step.stepKey === "follow_up",
    );

    expect(followUp.triggerStepId).not.toBe(baseline.body.id);
    expect(publishedIds.has(followUp.triggerStepId)).toBe(true);
  });
});

describe("publish refusals", () => {
  it("rejects a step triggered by the completion of the recurring block (FR-48c)", async () => {
    const { client, studyId, protocolId, coreVersionId } = await referenceProtocol();

    const detail = await client.get(`/api/studies/${studyId}/protocols/${protocolId}`).expect(200);
    const daily = detail.body.draft.steps.find(
      (step: { stepKey: string }) => step.stepKey === "daily",
    );
    const endline = detail.body.draft.steps.find(
      (step: { stepKey: string }) => step.stepKey === "endline",
    );

    await client
      .patch(`/api/studies/${studyId}/protocols/${protocolId}/steps/${endline.id}`, {
        triggerType: "STEP_COMPLETED",
        triggerStepId: daily.id,
        triggerOccurrenceIndex: 29,
        triggerFixedDate: null,
      })
      .expect(200);

    const refused = await client
      .post(`/api/studies/${studyId}/protocols/${protocolId}/publish`)
      .expect(409);

    expect(refused.body.error.code).toBe("PROTOCOL_STEP_COMPLETION_OF_RECURRING");
    // Names the step and what it depends on, so the builder can point at it.
    expect(refused.body.error.details[0]).toEqual({ path: "steps.endline", message: "daily" });
    expect(coreVersionId).toBeTruthy();
  });

  it("rejects an unqualified reference to the recurring block (FR-48a)", async () => {
    const { client, studyId, protocolId } = await referenceProtocol();

    const detail = await client.get(`/api/studies/${studyId}/protocols/${protocolId}`).expect(200);
    const daily = detail.body.draft.steps.find(
      (step: { stepKey: string }) => step.stepKey === "daily",
    );
    const endline = detail.body.draft.steps.find(
      (step: { stepKey: string }) => step.stepKey === "endline",
    );

    await client
      .patch(`/api/studies/${studyId}/protocols/${protocolId}/steps/${endline.id}`, {
        triggerType: "STEP_AVAILABLE",
        triggerStepId: daily.id,
        triggerFixedDate: null,
      })
      .expect(200);

    const refused = await client
      .post(`/api/studies/${studyId}/protocols/${protocolId}/publish`)
      .expect(409);

    expect(refused.body.error.code).toBe("PROTOCOL_TRIGGER_NEEDS_OCCURRENCE");
  });

  it("accepts STEP_AVAILABLE against a named occurrence of the block", async () => {
    const { client, studyId, protocolId } = await referenceProtocol();

    const detail = await client.get(`/api/studies/${studyId}/protocols/${protocolId}`).expect(200);
    const daily = detail.body.draft.steps.find(
      (step: { stepKey: string }) => step.stepKey === "daily",
    );
    const endline = detail.body.draft.steps.find(
      (step: { stepKey: string }) => step.stepKey === "endline",
    );

    await client
      .patch(`/api/studies/${studyId}/protocols/${protocolId}/steps/${endline.id}`, {
        triggerType: "STEP_AVAILABLE",
        triggerStepId: daily.id,
        triggerOccurrenceIndex: 29,
        triggerFixedDate: null,
        offsetIso: "P1D",
      })
      .expect(200);

    await client.post(`/api/studies/${studyId}/protocols/${protocolId}/publish`).expect(201);
  });

  it("rejects an empty protocol", async () => {
    const { client, studyId } = await studyWithInstruments();
    const protocol = await client
      .post(`/api/studies/${studyId}/protocols`, { name: "empty", description: "" })
      .expect(201);

    const refused = await client
      .post(`/api/studies/${studyId}/protocols/${protocol.body.id}/publish`)
      .expect(409);

    expect(refused.body.error.code).toBe("PROTOCOL_EMPTY");
  });

  it("rejects a step referencing a DRAFT questionnaire version (ADR-008)", async () => {
    const { client, studyId } = await studyWithInstruments();

    const questionnaire = await client
      .post(`/api/studies/${studyId}/questionnaires`, { name: "unpublished", description: "" })
      .expect(201);
    const protocol = await client
      .post(`/api/studies/${studyId}/protocols`, { name: "p", description: "" })
      .expect(201);

    const refused = await client
      .post(`/api/studies/${studyId}/protocols/${protocol.body.id}/steps`, {
        stepKey: "baseline",
        questionnaireVersionId: questionnaire.body.draft.id,
        triggerType: "ENROLLMENT",
        windowDurationIso: "P3D",
      })
      .expect(409);

    expect(refused.body.error.code).toBe("QUESTIONNAIRE_VERSION_NOT_PUBLISHED");
  });

  it("rejects a reminder interval below the platform minimum", async () => {
    const { client, studyId, coreVersionId } = await studyWithInstruments();
    const protocol = await client
      .post(`/api/studies/${studyId}/protocols`, { name: "p", description: "" })
      .expect(201);

    const refused = await client
      .post(`/api/studies/${studyId}/protocols/${protocol.body.id}/steps`, {
        stepKey: "baseline",
        questionnaireVersionId: coreVersionId,
        triggerType: "ENROLLMENT",
        windowDurationIso: "P3D",
        reminderPolicy: {
          initialDelayIso: "PT1H",
          // A typo for PT5H would aim a notification storm at every participant.
          intervalIso: "PT5M",
          maxReminders: 3,
          quietHoursStart: null,
          quietHoursEnd: null,
          quietHoursBehavior: "DEFER",
        },
      })
      .expect(400);

    expect(refused.body.error.code).toBe("VALIDATION_FAILED");
  });
});

describe("the published version is immutable", () => {
  it("refuses a direct UPDATE at the database level", async () => {
    const { client, studyId, protocolId } = await referenceProtocol();
    const published = await client
      .post(`/api/studies/${studyId}/protocols/${protocolId}/publish`)
      .expect(201);

    // Going around the service entirely: the trigger is the guarantee, not the
    // application's discipline.
    await expect(
      harness.db.execute(
        `update research.protocol_versions set status = 'DRAFT' where id = '${published.body.id}'`,
      ),
    ).rejects.toThrow();
  });
});

describe("the timeline preview", () => {
  const ENROLLED = "2026-09-04T09:12:00.000Z";

  it("reproduces the reference protocol's tabulated instants", async () => {
    const { client, studyId, protocolId } = await referenceProtocol();

    const preview = await client
      .post(`/api/studies/${studyId}/protocols/${protocolId}/preview`, {
        enrolledAt: ENROLLED,
        participantTimezone: "Europe/Istanbul",
        completions: {},
      })
      .expect(200);

    const byKey = new Map(
      preview.body.steps.map((step: { stepKey: string }) => [step.stepKey, step]),
    );
    const baseline = byKey.get("baseline") as { occurrences: { availableFrom: string }[] };
    const daily = byKey.get("daily") as { occurrences: { availableFrom: string }[] };
    const endline = byKey.get("endline") as {
      occurrences: { availableFrom: string; availableUntil: string }[];
    };

    expect(baseline.occurrences[0]?.availableFrom).toBe("2026-09-04T09:12:00.000Z");
    expect(daily.occurrences[0]?.availableFrom).toBe("2026-09-07T17:00:00.000Z");
    expect(daily.occurrences[29]?.availableFrom).toBe("2026-10-06T17:00:00.000Z");
    expect(endline.occurrences[0]?.availableFrom).toBe("2026-10-07T17:00:00.000Z");
    expect(endline.occurrences[0]?.availableUntil).toBe("2026-10-10T17:00:00.000Z");
  });

  it("gives the participant 32 sessions", async () => {
    const { client, studyId, protocolId } = await referenceProtocol();

    const preview = await client
      .post(`/api/studies/${studyId}/protocols/${protocolId}/preview`, {
        enrolledAt: ENROLLED,
        participantTimezone: "Europe/Istanbul",
        completions: {},
      })
      .expect(200);

    expect(preview.body.totalOccurrences).toBe(32);
  });

  it("labels every step of mode A unconditional", async () => {
    const { client, studyId, protocolId } = await referenceProtocol();

    const preview = await client
      .post(`/api/studies/${studyId}/protocols/${protocolId}/preview`, {
        enrolledAt: ENROLLED,
        participantTimezone: "Europe/Istanbul",
        completions: {},
      })
      .expect(200);

    expect(
      preview.body.steps.every(
        (step: { dependency: string }) => step.dependency === "UNCONDITIONAL",
      ),
    ).toBe(true);
  });

  it("previews a published version, not only the draft", async () => {
    const { client, studyId, protocolId } = await referenceProtocol();
    const published = await client
      .post(`/api/studies/${studyId}/protocols/${protocolId}/publish`)
      .expect(201);

    const preview = await client
      .post(
        `/api/studies/${studyId}/protocols/${protocolId}/versions/${published.body.id}/preview`,
        { enrolledAt: ENROLLED, participantTimezone: "Europe/Istanbul", completions: {} },
      )
      .expect(200);

    expect(preview.body.totalOccurrences).toBe(32);
  });
});
