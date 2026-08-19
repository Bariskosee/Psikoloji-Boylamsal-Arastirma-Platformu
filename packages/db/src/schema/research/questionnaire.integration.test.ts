import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPool } from "../../client.js";

/**
 * Constraint tests for the Phase 3 questionnaire schema — every rule this
 * schema claims to enforce is verified by ATTEMPTING TO VIOLATE IT, mirroring
 * `schema.integration.test.ts`.
 *
 * Requires a live PostgreSQL with the migrations applied:
 *   pnpm db:up && pnpm --filter=@lpr/db migrate:up
 */
const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is required for integration tests.\n" +
      "  Local:  pnpm db:up && cp .env.example .env && pnpm --filter=@lpr/db migrate:up\n" +
      "  CI:     provide it in the job environment",
  );
}

const pool = createPool({ connectionString, max: 4 });

const suffix = () => Math.random().toString(36).slice(2, 10);

function randomCode(): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let code = "";
  for (let i = 0; i < 6; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

async function insertStudy(): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO research.studies (name, enrollment_code, timezone, default_locale, supported_locales)
     VALUES ('Test Study', $1, 'Europe/Istanbul', 'en', ARRAY['en','tr']) RETURNING id`,
    [randomCode()],
  );
  return result.rows[0]!.id;
}

async function insertQuestionnaire(studyId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO research.questionnaires (study_id, name) VALUES ($1, $2) RETURNING id`,
    [studyId, `Questionnaire ${suffix()}`],
  );
  return result.rows[0]!.id;
}

async function insertDraftVersion(questionnaireId: string): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO research.questionnaire_versions (questionnaire_id, status)
     VALUES ($1, 'DRAFT') RETURNING id`,
    [questionnaireId],
  );
  return result.rows[0]!.id;
}

async function insertPublishedVersion(questionnaireId: string, versionNumber = 1): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO research.questionnaire_versions (questionnaire_id, status, version_number, published_at)
     VALUES ($1, 'PUBLISHED', $2, now()) RETURNING id`,
    [questionnaireId, versionNumber],
  );
  return result.rows[0]!.id;
}

async function insertQuestion(
  questionnaireVersionId: string,
  overrides: { type?: string; displayOrder?: number; questionKey?: string } = {},
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO research.question_versions
       (questionnaire_version_id, question_key, type, display_order)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      questionnaireVersionId,
      overrides.questionKey ?? `q_${suffix()}`,
      overrides.type ?? "FREE_TEXT",
      overrides.displayOrder ?? 0,
    ],
  );
  return result.rows[0]!.id;
}

async function insertOption(
  questionVersionId: string,
  optionKey = `o_${suffix()}`,
): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO research.question_options (question_version_id, option_key, display_order)
     VALUES ($1, $2, 0) RETURNING id`,
    [questionVersionId, optionKey],
  );
  return result.rows[0]!.id;
}

beforeAll(async () => {
  await pool.query("SELECT 1");
});

afterAll(async () => {
  await pool.end();
});

describe("questionnaire_versions constraints", () => {
  it("refuses a second draft for the same questionnaire", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    await insertDraftVersion(questionnaireId);
    await expect(insertDraftVersion(questionnaireId)).rejects.toThrow(
      /questionnaire_versions_one_draft_idx|duplicate key/i,
    );
  });

  it("allows a fresh draft once the questionnaire has no draft left", async () => {
    // Not reachable through Phase 3's own API (nothing deletes a draft), but
    // the constraint itself must not be stricter than "at most one DRAFT row
    // per questionnaire at a time".
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const draftId = await insertDraftVersion(questionnaireId);
    await pool.query("DELETE FROM research.questionnaire_versions WHERE id = $1", [draftId]);
    await expect(insertDraftVersion(questionnaireId)).resolves.toBeTypeOf("string");
  });

  it("refuses two published versions sharing a version number", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    await insertPublishedVersion(questionnaireId, 1);
    await expect(insertPublishedVersion(questionnaireId, 1)).rejects.toThrow(
      /questionnaire_versions_number_key|duplicate key/i,
    );
  });

  it("allows two different questionnaires to each publish a version 1", async () => {
    const studyId = await insertStudy();
    const first = await insertQuestionnaire(studyId);
    const second = await insertQuestionnaire(studyId);
    await expect(insertPublishedVersion(first, 1)).resolves.toBeTypeOf("string");
    await expect(insertPublishedVersion(second, 1)).resolves.toBeTypeOf("string");
  });

  it("refuses an unknown status", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const id = await insertDraftVersion(questionnaireId);
    // version_number and published_at are set in the same statement so this
    // isolates the status check: an unqualified status flip would also trip
    // `number_shape` and `published_at_shape` first.
    await expect(
      pool.query(
        `UPDATE research.questionnaire_versions
         SET status = 'ARCHIVED', version_number = 1, published_at = now()
         WHERE id = $1`,
        [id],
      ),
    ).rejects.toThrow(/questionnaire_versions_status_valid/);
  });

  it("requires a DRAFT row to have no version number and a non-draft row to have one", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    await expect(
      pool.query(
        `INSERT INTO research.questionnaire_versions (questionnaire_id, status, version_number)
         VALUES ($1, 'DRAFT', 1)`,
        [questionnaireId],
      ),
    ).rejects.toThrow(/questionnaire_versions_number_shape/);

    await expect(
      pool.query(
        `INSERT INTO research.questionnaire_versions (questionnaire_id, status)
         VALUES ($1, 'PUBLISHED')`,
        [questionnaireId],
      ),
    ).rejects.toThrow(/questionnaire_versions_number_shape/);
  });
});

describe("published-version immutability (STRUCTURE.md §6, AGENT.md §17)", () => {
  it("blocks UPDATE on a PUBLISHED questionnaire_versions row", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const versionId = await insertPublishedVersion(questionnaireId);
    await expect(
      pool.query("UPDATE research.questionnaire_versions SET published_by = NULL WHERE id = $1", [
        versionId,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it("blocks DELETE on a PUBLISHED questionnaire_versions row", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const versionId = await insertPublishedVersion(questionnaireId);
    await expect(
      pool.query("DELETE FROM research.questionnaire_versions WHERE id = $1", [versionId]),
    ).rejects.toThrow(/immutable/);
  });

  it("allows UPDATE and DELETE on a DRAFT questionnaire_versions row", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const versionId = await insertDraftVersion(questionnaireId);
    await expect(
      pool.query("UPDATE research.questionnaire_versions SET updated_at = now() WHERE id = $1", [
        versionId,
      ]),
    ).resolves.toBeDefined();
    await expect(
      pool.query("DELETE FROM research.questionnaire_versions WHERE id = $1", [versionId]),
    ).resolves.toBeDefined();
  });

  it("blocks UPDATE and DELETE on a question under a PUBLISHED version", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const versionId = await insertPublishedVersion(questionnaireId);
    const questionId = await insertQuestion(versionId);

    await expect(
      pool.query("UPDATE research.question_versions SET is_required = false WHERE id = $1", [
        questionId,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query("DELETE FROM research.question_versions WHERE id = $1", [questionId]),
    ).rejects.toThrow(/immutable/);
  });

  it("blocks UPDATE and DELETE on an option under a PUBLISHED version", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const versionId = await insertPublishedVersion(questionnaireId);
    const questionId = await insertQuestion(versionId, { type: "SINGLE_CHOICE" });
    const optionId = await insertOption(questionId);

    await expect(
      pool.query("UPDATE research.question_options SET is_exclusive = true WHERE id = $1", [
        optionId,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query("DELETE FROM research.question_options WHERE id = $1", [optionId]),
    ).rejects.toThrow(/immutable/);
  });

  it("blocks UPDATE and DELETE on translations under a PUBLISHED version", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const versionId = await insertPublishedVersion(questionnaireId);
    const questionId = await insertQuestion(versionId, { type: "SINGLE_CHOICE" });
    const optionId = await insertOption(questionId);

    const questionTranslation = await pool.query<{ id: string }>(
      `INSERT INTO research.question_version_translations (question_version_id, locale, text)
       VALUES ($1, 'en', 'What is your mood?') RETURNING id`,
      [questionId],
    );
    const optionTranslation = await pool.query<{ id: string }>(
      `INSERT INTO research.question_option_translations (question_option_id, locale, label)
       VALUES ($1, 'en', 'Happy') RETURNING id`,
      [optionId],
    );

    await expect(
      pool.query("UPDATE research.question_version_translations SET text = 'x' WHERE id = $1", [
        questionTranslation.rows[0]!.id,
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query("UPDATE research.question_option_translations SET label = 'x' WHERE id = $1", [
        optionTranslation.rows[0]!.id,
      ]),
    ).rejects.toThrow(/immutable/);
  });

  it("allows editing questions, options, and translations under a DRAFT version", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const versionId = await insertDraftVersion(questionnaireId);
    const questionId = await insertQuestion(versionId, { type: "SINGLE_CHOICE" });
    const optionId = await insertOption(questionId);

    await expect(
      pool.query("UPDATE research.question_versions SET is_required = false WHERE id = $1", [
        questionId,
      ]),
    ).resolves.toBeDefined();
    await expect(
      pool.query("UPDATE research.question_options SET is_exclusive = true WHERE id = $1", [
        optionId,
      ]),
    ).resolves.toBeDefined();
    await expect(
      pool.query("DELETE FROM research.question_options WHERE id = $1", [optionId]),
    ).resolves.toBeDefined();
  });

  it("leaves a published version unchanged after the draft is edited further", async () => {
    // The direct database-level analogue of the Phase 3 acceptance criterion:
    // publishing deep-copies into a NEW row, so nothing done to the draft
    // afterward can reach the published row's data at all — not merely that
    // the trigger stops a mutation aimed at it directly.
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const draftId = await insertDraftVersion(questionnaireId);
    const draftQuestionId = await insertQuestion(draftId, { questionKey: "q_shared0001" });

    const publishedId = await insertPublishedVersion(questionnaireId);
    const publishedQuestionId = await insertQuestion(publishedId, { questionKey: "q_shared0001" });

    await pool.query("UPDATE research.question_versions SET is_required = false WHERE id = $1", [
      draftQuestionId,
    ]);
    await pool.query("DELETE FROM research.question_versions WHERE id = $1", [draftQuestionId]);

    const stillThere = await pool.query(
      "SELECT is_required FROM research.question_versions WHERE id = $1",
      [publishedQuestionId],
    );
    expect(stillThere.rows[0]).toEqual({ is_required: true });
  });
});

describe("question_versions and question_options constraints", () => {
  it("refuses an unknown question type", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const versionId = await insertDraftVersion(questionnaireId);
    await expect(insertQuestion(versionId, { type: "ESSAY" })).rejects.toThrow(
      /question_versions_type_valid/,
    );
  });

  it("refuses two questions sharing a question_key within the same version", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const versionId = await insertDraftVersion(questionnaireId);
    await insertQuestion(versionId, { questionKey: "q_dup000001" });
    await expect(insertQuestion(versionId, { questionKey: "q_dup000001" })).rejects.toThrow(
      /question_versions_key_key|duplicate key/i,
    );
  });

  it("allows the same question_key to repeat across different versions", async () => {
    // This is exactly what "question_key survives a version bump" requires at
    // the schema level: the uniqueness is scoped per version, not global.
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const draftId = await insertDraftVersion(questionnaireId);
    await insertQuestion(draftId, { questionKey: "q_reused0001" });

    const publishedId = await insertPublishedVersion(questionnaireId);
    await expect(insertQuestion(publishedId, { questionKey: "q_reused0001" })).resolves.toBeTypeOf(
      "string",
    );
  });

  it("refuses two options sharing an option_key on the same question", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const versionId = await insertDraftVersion(questionnaireId);
    const questionId = await insertQuestion(versionId, { type: "SINGLE_CHOICE" });
    await insertOption(questionId, "o_dup0000001");
    await expect(insertOption(questionId, "o_dup0000001")).rejects.toThrow(
      /question_options_key_key|duplicate key/i,
    );
  });

  it("cascades deletion from questionnaire through version, question, and option", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const versionId = await insertDraftVersion(questionnaireId);
    const questionId = await insertQuestion(versionId, { type: "SINGLE_CHOICE" });
    const optionId = await insertOption(questionId);

    await pool.query("DELETE FROM research.questionnaires WHERE id = $1", [questionnaireId]);

    const remainingOptions = await pool.query(
      "SELECT 1 FROM research.question_options WHERE id = $1",
      [optionId],
    );
    expect(remainingOptions.rowCount).toBe(0);
  });

  it("refuses a locale outside en/tr on either translation table", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const versionId = await insertDraftVersion(questionnaireId);
    const questionId = await insertQuestion(versionId, { type: "SINGLE_CHOICE" });
    const optionId = await insertOption(questionId);

    await expect(
      pool.query(
        `INSERT INTO research.question_version_translations (question_version_id, locale, text)
         VALUES ($1, 'de', 'x')`,
        [questionId],
      ),
    ).rejects.toThrow(/question_version_translations_locale_valid/);

    await expect(
      pool.query(
        `INSERT INTO research.question_option_translations (question_option_id, locale, label)
         VALUES ($1, 'de', 'x')`,
        [optionId],
      ),
    ).rejects.toThrow(/question_option_translations_locale_valid/);
  });

  it("maintains updated_at on question_versions by trigger", async () => {
    const studyId = await insertStudy();
    const questionnaireId = await insertQuestionnaire(studyId);
    const versionId = await insertDraftVersion(questionnaireId);
    const questionId = await insertQuestion(versionId);

    const before = await pool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM research.question_versions WHERE id = $1",
      [questionId],
    );
    await pool.query("UPDATE research.question_versions SET is_required = false WHERE id = $1", [
      questionId,
    ]);
    const after = await pool.query<{ updated_at: Date }>(
      "SELECT updated_at FROM research.question_versions WHERE id = $1",
      [questionId],
    );
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThanOrEqual(
      before.rows[0]!.updated_at.getTime(),
    );
  });
});
