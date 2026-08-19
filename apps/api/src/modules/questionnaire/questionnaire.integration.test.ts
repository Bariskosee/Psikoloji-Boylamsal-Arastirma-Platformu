import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { auditEvents } from "@lpr/db";
import {
  Client,
  VALID_STUDY,
  addMember,
  createHarness,
  createUser,
  resetDatabase,
  type Harness,
} from "../../testing/harness.js";

/**
 * The questionnaire builder end to end (PLAN.md Phase 3 acceptance criteria).
 *
 * The properties asserted here are the ones the phase exists to guarantee:
 * publish deep-copies, a published version never changes afterwards,
 * `question_key` survives a version bump, and a researcher without
 * `questionnaire:edit` cannot reach any write route. None of them can be
 * demonstrated against a mocked database, because half of them are enforced
 * by constraints and triggers.
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

interface Fixture {
  client: Client;
  studyId: string;
  questionnaireId: string;
  draftId: string;
}

async function fixture(): Promise<Fixture> {
  const owner = await createUser(harness.db);
  const client = await Client.login(harness.app, owner);
  const study = await client.post("/api/studies", VALID_STUDY).expect(201);
  const questionnaire = await client
    .post(`/api/studies/${study.body.id}/questionnaires`, {
      name: "Daily mood placeholder",
      description: "Placeholder instrument for tests",
    })
    .expect(201);

  return {
    client,
    studyId: study.body.id,
    questionnaireId: questionnaire.body.id,
    draftId: questionnaire.body.draft.id,
  };
}

function base(f: Fixture): string {
  return `/api/studies/${f.studyId}/questionnaires/${f.questionnaireId}`;
}

/** A question of `type`, with two options when the type needs them. */
async function addQuestion(
  f: Fixture,
  type: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; questionKey: string; optionIds: string[] }> {
  const response = await f.client
    .post(`${base(f)}/questions`, {
      type,
      translations: { en: `Sample ${type} question`, tr: `Örnek ${type} sorusu` },
      ...overrides,
    })
    .expect(201);

  const optionIds: string[] = [];
  if (type === "SINGLE_CHOICE" || type === "MULTI_CHOICE") {
    for (const [index, label] of [
      { en: "Sample option A", tr: "Örnek seçenek A" },
      { en: "Sample option B", tr: "Örnek seçenek B" },
    ].entries()) {
      const option = await f.client
        .post(`${base(f)}/questions/${response.body.id}/options`, {
          translations: label,
          valueNumber: index,
        })
        .expect(201);
      optionIds.push(option.body.id);
    }
  }

  return { id: response.body.id, questionKey: response.body.questionKey, optionIds };
}

describe("questionnaire CRUD", () => {
  it("creates a questionnaire with exactly one empty DRAFT version", async () => {
    const f = await fixture();
    const detail = await f.client.get(base(f)).expect(200);

    expect(detail.body.draft.status).toBe("DRAFT");
    expect(detail.body.draft.versionNumber).toBeNull();
    expect(detail.body.draft.questions).toEqual([]);
    expect(detail.body.publishedVersions).toEqual([]);
  });

  it("records questionnaire.created in the audit trail", async () => {
    const f = await fixture();
    const events = await harness.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.studyId, f.studyId), eq(auditEvents.action, "questionnaire.created")),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.entityId).toBe(f.questionnaireId);
  });

  it("renames a questionnaire without touching its versions", async () => {
    const f = await fixture();
    const renamed = await f.client.patch(base(f), { name: "Renamed" }).expect(200);
    expect(renamed.body.name).toBe("Renamed");
    expect(renamed.body.draft.id).toBe(f.draftId);
  });

  it("returns QUESTIONNAIRE_NOT_FOUND for another study's questionnaire", async () => {
    const mine = await fixture();
    const theirs = await fixture();

    const response = await mine.client
      .get(`/api/studies/${mine.studyId}/questionnaires/${theirs.questionnaireId}`)
      .expect(404);
    expect(response.body.error.code).toBe("QUESTIONNAIRE_NOT_FOUND");
  });

  it("returns QUESTIONNAIRE_NOT_FOUND rather than a 500 for a malformed id", async () => {
    const f = await fixture();
    const response = await f.client
      .get(`/api/studies/${f.studyId}/questionnaires/not-a-uuid`)
      .expect(404);
    expect(response.body.error.code).toBe("QUESTIONNAIRE_NOT_FOUND");
  });
});

describe("question and option CRUD", () => {
  it("accepts all five MVP types and defaults their config", async () => {
    const f = await fixture();
    for (const type of ["SINGLE_CHOICE", "MULTI_CHOICE", "LIKERT", "NUMERIC", "FREE_TEXT"]) {
      await addQuestion(f, type);
    }

    const detail = await f.client.get(base(f)).expect(200);
    expect(detail.body.draft.questions).toHaveLength(5);
    const likert = detail.body.draft.questions.find((q: { type: string }) => q.type === "LIKERT");
    // The schema's defaults, applied server-side — the client sent `{}`.
    expect(likert.config).toMatchObject({ minValue: 1, maxValue: 5 });
  });

  it("assigns a stable, unique question_key on creation", async () => {
    const f = await fixture();
    const first = await addQuestion(f, "FREE_TEXT");
    const second = await addQuestion(f, "FREE_TEXT");

    expect(first.questionKey).toMatch(/^q_[0-9a-z]{10}$/);
    expect(first.questionKey).not.toBe(second.questionKey);

    // Editing the text must not regenerate it — it is an export column name.
    const edited = await f.client
      .patch(`${base(f)}/questions/${first.id}`, { translations: { en: "Edited text" } })
      .expect(200);
    expect(edited.body.questionKey).toBe(first.questionKey);
  });

  it("rejects a config that does not match the question's type", async () => {
    const f = await fixture();
    const response = await f.client
      .post(`${base(f)}/questions`, {
        type: "LIKERT",
        translations: { en: "Sample question" },
        config: { minValue: 5, maxValue: 1 },
      })
      .expect(400);
    expect(response.body.error.code).toBe("VALIDATION_FAILED");
  });

  it("refuses options on a type that does not have them", async () => {
    const f = await fixture();
    const question = await addQuestion(f, "FREE_TEXT");
    const response = await f.client
      .post(`${base(f)}/questions/${question.id}/options`, {
        translations: { en: "Sample option" },
      })
      .expect(409);
    expect(response.body.error.code).toBe("CONFLICT");
  });

  it("stores Turkish and English text for a question and its options", async () => {
    const f = await fixture();
    const question = await addQuestion(f, "SINGLE_CHOICE");

    const detail = await f.client.get(base(f)).expect(200);
    const stored = detail.body.draft.questions[0];
    expect(stored.translations.tr).toBe("Örnek SINGLE_CHOICE sorusu");
    expect(stored.translations.en).toBe("Sample SINGLE_CHOICE question");
    expect(stored.options[0].translations.tr).toBe("Örnek seçenek A");
    expect(stored.options).toHaveLength(question.optionIds.length);
  });

  it("stores a script payload as literal text, never as markup", async () => {
    const f = await fixture();
    const payload = "<script>alert('xss')</script>";
    const created = await f.client
      .post(`${base(f)}/questions`, {
        type: "FREE_TEXT",
        translations: { en: payload },
      })
      .expect(201);

    // Byte-for-byte what was sent: no escaping, no stripping, no encoding.
    // Rendering it safely is the frontend's job (React escapes by default);
    // the API's job is not to corrupt a researcher's legitimate "<" either.
    expect(created.body.translations.en).toBe(payload);
    const reread = await f.client.get(base(f)).expect(200);
    expect(reread.body.draft.questions[0].translations.en).toBe(payload);
  });

  it("keeps the order unambiguous when a question is added after a deletion", async () => {
    const f = await fixture();
    const first = await addQuestion(f, "FREE_TEXT");
    const middle = await addQuestion(f, "FREE_TEXT");
    const last = await addQuestion(f, "FREE_TEXT");

    await f.client.delete(`${base(f)}/questions/${middle.id}`).expect(204);
    const added = await addQuestion(f, "NUMERIC");

    const detail = await f.client.get(base(f)).expect(200);
    const orders = detail.body.draft.questions.map((q: { displayOrder: number }) => q.displayOrder);
    // Distinct, so two questions can never claim the same position.
    expect(new Set(orders).size).toBe(orders.length);
    expect(detail.body.draft.questions.map((q: { id: string }) => q.id)).toEqual([
      first.id,
      last.id,
      added.id,
    ]);
  });

  it("deletes a question and its options together", async () => {
    const f = await fixture();
    const question = await addQuestion(f, "MULTI_CHOICE");
    await f.client.delete(`${base(f)}/questions/${question.id}`).expect(204);

    const detail = await f.client.get(base(f)).expect(200);
    expect(detail.body.draft.questions).toEqual([]);
  });
});

describe("reordering", () => {
  it("persists a reorder of twenty questions and is idempotent", async () => {
    const f = await fixture();
    const ids: string[] = [];
    for (let i = 0; i < 20; i += 1) {
      const question = await addQuestion(f, "FREE_TEXT");
      ids.push(question.id);
    }

    const reversed = [...ids].reverse();
    const first = await f.client.put(`${base(f)}/questions/order`, { questionIds: reversed });
    expect(first.status).toBe(200);
    expect(first.body.questions.map((q: { id: string }) => q.id)).toEqual(reversed);
    expect(first.body.questions.map((q: { displayOrder: number }) => q.displayOrder)).toEqual(
      Array.from({ length: 20 }, (_, i) => i),
    );

    // Same request again — the acceptance criterion is that it is idempotent,
    // not merely that it does not error.
    const second = await f.client
      .put(`${base(f)}/questions/order`, { questionIds: reversed })
      .expect(200);
    expect(second.body.questions.map((q: { id: string }) => q.id)).toEqual(reversed);

    const reread = await f.client.get(base(f)).expect(200);
    expect(reread.body.draft.questions.map((q: { id: string }) => q.id)).toEqual(reversed);
  });

  it("rejects a reorder that drops, duplicates, or invents an id", async () => {
    const f = await fixture();
    const a = await addQuestion(f, "FREE_TEXT");
    const b = await addQuestion(f, "FREE_TEXT");

    for (const questionIds of [
      [a.id],
      [a.id, a.id],
      [a.id, "00000000-0000-4000-8000-000000000000"],
    ]) {
      const response = await f.client.put(`${base(f)}/questions/order`, { questionIds });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("INVALID_REORDER");
    }

    const reread = await f.client.get(base(f)).expect(200);
    expect(reread.body.draft.questions.map((q: { id: string }) => q.id)).toEqual([a.id, b.id]);
  });

  it("reorders a question's options", async () => {
    const f = await fixture();
    const question = await addQuestion(f, "SINGLE_CHOICE");
    const reversed = [...question.optionIds].reverse();

    const response = await f.client
      .put(`${base(f)}/questions/${question.id}/options/order`, { optionIds: reversed })
      .expect(200);
    expect(response.body.options.map((o: { id: string }) => o.id)).toEqual(reversed);
  });
});

describe("publish", () => {
  it("refuses to publish an empty questionnaire", async () => {
    const f = await fixture();
    const response = await f.client.post(`${base(f)}/publish`).expect(409);
    expect(response.body.error.code).toBe("CONFLICT");
  });

  it("refuses to publish a choice question with fewer than two options", async () => {
    const f = await fixture();
    const created = await f.client
      .post(`${base(f)}/questions`, {
        type: "SINGLE_CHOICE",
        translations: { en: "Sample question" },
      })
      .expect(201);
    await f.client
      .post(`${base(f)}/questions/${created.body.id}/options`, {
        translations: { en: "Only option" },
      })
      .expect(201);

    await f.client.post(`${base(f)}/publish`).expect(409);
  });

  it("deep-copies the draft, including translations and options", async () => {
    const f = await fixture();
    const drafted = await addQuestion(f, "SINGLE_CHOICE");

    const published = await f.client.post(`${base(f)}/publish`).expect(201);
    expect(published.body.status).toBe("PUBLISHED");
    expect(published.body.versionNumber).toBe(1);
    expect(published.body.questions).toHaveLength(1);

    const copy = published.body.questions[0];
    // A copy, not the same row.
    expect(copy.id).not.toBe(drafted.id);
    // …carrying the identity that must survive versioning.
    expect(copy.questionKey).toBe(drafted.questionKey);
    expect(copy.translations).toEqual({
      en: "Sample SINGLE_CHOICE question",
      tr: "Örnek SINGLE_CHOICE sorusu",
    });
    expect(copy.options).toHaveLength(2);
    expect(copy.options[0].translations.tr).toBe("Örnek seçenek A");
    expect(copy.options[0].id).not.toBe(drafted.optionIds[0]);

    // The draft is untouched and still editable.
    const detail = await f.client.get(base(f)).expect(200);
    expect(detail.body.draft.id).toBe(f.draftId);
    expect(detail.body.draft.questions[0].id).toBe(drafted.id);
    expect(detail.body.publishedVersions).toHaveLength(1);
  });

  it("leaves version 1 provably unchanged after the draft is edited and republished", async () => {
    const f = await fixture();
    const original = await addQuestion(f, "FREE_TEXT");
    const v1 = await f.client.post(`${base(f)}/publish`).expect(201);

    await f.client
      .patch(`${base(f)}/questions/${original.id}`, {
        translations: { en: "Rewritten after publication" },
        isRequired: false,
      })
      .expect(200);
    await addQuestion(f, "NUMERIC");
    const v2 = await f.client.post(`${base(f)}/publish`).expect(201);

    expect(v2.body.versionNumber).toBe(2);
    expect(v2.body.questions).toHaveLength(2);

    const reread = await f.client.get(`${base(f)}/versions/${v1.body.id}`).expect(200);
    expect(reread.body.questions).toHaveLength(1);
    expect(reread.body.questions[0].translations.en).toBe("Sample FREE_TEXT question");
    expect(reread.body.questions[0].isRequired).toBe(true);
    expect(reread.body.updatedAt).toBe(v1.body.updatedAt);

    // question_key survives the version bump — this is what makes a
    // longitudinal export line the two waves up (FR-43).
    expect(v2.body.questions[0].questionKey).toBe(original.questionKey);
  });

  it("records questionnaire.version.published in the audit trail", async () => {
    const f = await fixture();
    await addQuestion(f, "FREE_TEXT");
    const published = await f.client.post(`${base(f)}/publish`).expect(201);

    const events = await harness.db
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.studyId, f.studyId),
          eq(auditEvents.action, "questionnaire.version.published"),
        ),
      );
    expect(events).toHaveLength(1);
    expect(events[0]!.entityId).toBe(published.body.id);
  });

  it("preserves page grouping through publication", async () => {
    const f = await fixture();
    await addQuestion(f, "FREE_TEXT", { pageIndex: 0 });
    await addQuestion(f, "NUMERIC", { pageIndex: 1 });

    const published = await f.client.post(`${base(f)}/publish`).expect(201);
    expect(published.body.questions.map((q: { pageIndex: number }) => q.pageIndex)).toEqual([0, 1]);
  });
});

/**
 * PLAN.md Phase 3, acceptance criterion 1, end to end.
 *
 * Kept as one long test rather than split apart: what is being asserted is
 * that a realistic questionnaire — more than ten questions, all five types,
 * spread over several pages, in two languages — survives a publish intact.
 * Splitting it would assert the same steps against smaller fixtures and stop
 * testing the thing the criterion is about.
 */
describe("acceptance: a real multi-page questionnaire", () => {
  it("builds twelve questions across three pages in two languages and publishes v1", async () => {
    const f = await fixture();

    const types = [
      "SINGLE_CHOICE",
      "MULTI_CHOICE",
      "LIKERT",
      "NUMERIC",
      "FREE_TEXT",
      "SINGLE_CHOICE",
      "LIKERT",
      "NUMERIC",
      "FREE_TEXT",
      "MULTI_CHOICE",
      "LIKERT",
      "FREE_TEXT",
    ];
    const created = [];
    for (const [index, type] of types.entries()) {
      created.push(await addQuestion(f, type, { pageIndex: Math.floor(index / 4) }));
    }

    const published = await f.client.post(`${base(f)}/publish`).expect(201);
    expect(published.body.versionNumber).toBe(1);
    expect(published.body.questions).toHaveLength(12);

    // All five types made it through.
    expect(new Set(published.body.questions.map((q: { type: string }) => q.type)).size).toBe(5);

    // Three pages, four questions each, in the order they were built.
    expect(published.body.questions.map((q: { pageIndex: number }) => q.pageIndex)).toEqual([
      0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
    ]);
    expect(published.body.questions.map((q: { questionKey: string }) => q.questionKey)).toEqual(
      created.map((q) => q.questionKey),
    );

    // Both languages, on questions and on options.
    for (const question of published.body.questions) {
      expect(Object.keys(question.translations).sort()).toEqual(["en", "tr"]);
      for (const option of question.options) {
        expect(Object.keys(option.translations).sort()).toEqual(["en", "tr"]);
      }
    }

    // Every choice question carries its two options into the published copy.
    const choiceQuestions = published.body.questions.filter((q: { type: string }) =>
      ["SINGLE_CHOICE", "MULTI_CHOICE"].includes(q.type),
    );
    expect(choiceQuestions).toHaveLength(4);
    for (const question of choiceQuestions) expect(question.options).toHaveLength(2);
  });
});

describe("authorization", () => {
  it("keeps the whole resource at EDITOR, reads included (STRUCTURE.md §12)", async () => {
    const f = await fixture();
    await addQuestion(f, "FREE_TEXT");

    const viewer = await createUser(harness.db);
    await addMember(harness.db, f.studyId, viewer.id, "VIEWER");
    const viewerClient = await Client.login(harness.app, viewer);

    for (const response of [
      await viewerClient.get(`/api/studies/${f.studyId}/questionnaires`),
      await viewerClient.get(base(f)),
      await viewerClient.post(`${base(f)}/publish`),
    ]) {
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("STUDY_ROLE_REQUIRED");
    }
  });

  it("lets an EDITOR build and publish", async () => {
    const f = await fixture();
    const editor = await createUser(harness.db);
    await addMember(harness.db, f.studyId, editor.id, "EDITOR");
    const editorClient = await Client.login(harness.app, editor);

    await editorClient.get(`/api/studies/${f.studyId}/questionnaires`).expect(200);
    await editorClient
      .post(`${base(f)}/questions`, {
        type: "FREE_TEXT",
        translations: { en: "Sample question" },
      })
      .expect(201);
    await editorClient.post(`${base(f)}/publish`).expect(201);
  });

  it("hides another study's questionnaires entirely from a non-member", async () => {
    const f = await fixture();
    const outsider = await createUser(harness.db);
    const outsiderClient = await Client.login(harness.app, outsider);

    const response = await outsiderClient.get(`/api/studies/${f.studyId}/questionnaires`);
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("STUDY_NOT_FOUND");
  });

  it("rejects a write without the CSRF header", async () => {
    const f = await fixture();
    const response = await f.client.postWithoutCsrf(`/api/studies/${f.studyId}/questionnaires`, {
      name: "No CSRF token",
    });
    expect(response.status).toBe(403);
  });
});
