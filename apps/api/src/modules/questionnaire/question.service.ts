import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  questionOptionTranslations,
  questionOptions,
  questionVersionTranslations,
  questionVersions,
  questionnaireVersions,
  type Database,
  type QuestionOptionRow,
  type QuestionVersionRow,
} from "@lpr/db";
import {
  assignDisplayOrder,
  generateOptionKey,
  generateQuestionKey,
  planReorder,
  requiresOptions,
  validateQuestionConfig,
  ENTITY_KEY_BYTES,
} from "@lpr/domain";
import type {
  CreateQuestionOptionRequest,
  CreateQuestionRequest,
  QuestionOptionResponse,
  QuestionResponse,
  QuestionType,
  ReorderOptionsRequest,
  ReorderQuestionsRequest,
  UpdateQuestionOptionRequest,
  UpdateQuestionRequest,
} from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { generateRandomBytes } from "../../common/crypto.js";
import { DATABASE } from "../database/database.module.js";
import { QuestionnaireService, toLocaleRecord, toOptionResponse } from "./questionnaire.service.js";

/**
 * Question and option CRUD, and their reordering (PLAN.md Phase 3).
 *
 * Every operation here targets the questionnaire's current DRAFT version —
 * there is no route that accepts an explicit version id, so a request can
 * structurally never reach a published version's content. The database's
 * immutability trigger (migration 0001) is the defence-in-depth backstop,
 * not the primary guard.
 *
 * No individual audit event per question or option change: drafting a
 * ten-question form produces dozens of these calls, and NFR-05 asks for the
 * trail to cover creation and publication, not every keystroke of drafting.
 * `questionnaire.version.published` is where the drafted content becomes an
 * auditable fact.
 *
 * ── On `updatedAt: now` in the UPDATE statements ─────────────────────────────
 * It is passed for symmetry with the INSERTs and is then OVERWRITTEN: migration
 * 0000's `public.set_updated_at()` trigger sets `updated_at = now()` from the
 * database clock on every UPDATE, so the injected `Clock` governs `created_at`
 * and the audit trail but not this column. Nothing depends on it doing
 * otherwise. Do not write a test that expects a fake clock to show up in
 * `updated_at` — it will not.
 */
@Injectable()
export class QuestionService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly questionnaires: QuestionnaireService,
  ) {}

  async createQuestion(
    studyId: string,
    questionnaireId: string,
    input: CreateQuestionRequest,
    now: Date,
  ): Promise<QuestionResponse> {
    const draft = await this.requireDraft(studyId, questionnaireId);
    const validation = validateQuestionConfig(input.type, input.config);
    if (!validation.ok) throw ApiErrors.validationFailed(validation.errors ?? []);

    const questionId = await this.db.transaction(async (tx) => {
      // Lock the draft version row FIRST. `max(display_order)` read without it
      // is a lost update: two concurrent creates both see the same maximum and
      // both claim the next position, and no unique constraint catches it —
      // the questionnaire's order is then silently ambiguous until someone
      // reorders. Serialising on the parent row costs nothing at builder
      // scale, and `publish` already takes exactly this lock.
      await tx
        .select({ id: questionnaireVersions.id })
        .from(questionnaireVersions)
        .where(eq(questionnaireVersions.id, draft.id))
        .for("update");

      // `max + 1`, not `count`: deleting a question leaves a gap, and a
      // count-based order would then collide with a surviving row, making the
      // questionnaire's order ambiguous until the next reorder.
      const orderRows = await tx
        .select({ max: sql<number | null>`max(${questionVersions.displayOrder})` })
        .from(questionVersions)
        .where(eq(questionVersions.questionnaireVersionId, draft.id));

      const questionKey = generateQuestionKey(generateRandomBytes(ENTITY_KEY_BYTES));
      const [inserted] = await tx
        .insert(questionVersions)
        .values({
          questionnaireVersionId: draft.id,
          questionKey,
          type: input.type,
          isRequired: input.isRequired,
          pageIndex: input.pageIndex,
          displayOrder: nextOrder(orderRows[0]?.max),
          config: validation.config,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: questionVersions.id });
      if (!inserted) throw new Error("question version insert returned no row");

      await tx.insert(questionVersionTranslations).values(
        Object.entries(input.translations).map(([locale, text]) => ({
          questionVersionId: inserted.id,
          locale,
          text,
          createdAt: now,
          updatedAt: now,
        })),
      );

      return inserted.id;
    });

    return this.loadQuestion(this.db, questionId);
  }

  async updateQuestion(
    studyId: string,
    questionnaireId: string,
    questionId: string,
    input: UpdateQuestionRequest,
    now: Date,
  ): Promise<QuestionResponse> {
    const draft = await this.requireDraft(studyId, questionnaireId);
    const existing = await this.requireDraftQuestion(draft.id, questionId);

    let config: unknown = existing.config;
    if (input.config !== undefined) {
      const validation = validateQuestionConfig(existing.type as QuestionType, input.config);
      if (!validation.ok) throw ApiErrors.validationFailed(validation.errors ?? []);
      config = validation.config;
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(questionVersions)
        .set({
          ...(input.isRequired !== undefined ? { isRequired: input.isRequired } : {}),
          ...(input.pageIndex !== undefined ? { pageIndex: input.pageIndex } : {}),
          ...(input.config !== undefined ? { config } : {}),
          updatedAt: now,
        })
        .where(eq(questionVersions.id, questionId));

      if (input.translations !== undefined) {
        for (const [locale, text] of Object.entries(input.translations)) {
          await tx
            .insert(questionVersionTranslations)
            .values({ questionVersionId: questionId, locale, text, createdAt: now, updatedAt: now })
            .onConflictDoUpdate({
              target: [
                questionVersionTranslations.questionVersionId,
                questionVersionTranslations.locale,
              ],
              set: { text, updatedAt: now },
            });
        }
      }
    });

    return this.loadQuestion(this.db, questionId);
  }

  async deleteQuestion(
    studyId: string,
    questionnaireId: string,
    questionId: string,
  ): Promise<void> {
    const draft = await this.requireDraft(studyId, questionnaireId);
    const deleted = await this.db
      .delete(questionVersions)
      .where(
        and(
          eq(questionVersions.id, questionId),
          eq(questionVersions.questionnaireVersionId, draft.id),
        ),
      )
      .returning({ id: questionVersions.id });
    if (deleted.length === 0) throw ApiErrors.questionNotFound();
  }

  async reorderQuestions(
    studyId: string,
    questionnaireId: string,
    input: ReorderQuestionsRequest,
    now: Date,
  ): Promise<QuestionResponse[]> {
    const draft = await this.requireDraft(studyId, questionnaireId);
    const current = await this.db
      .select({ id: questionVersions.id })
      .from(questionVersions)
      .where(eq(questionVersions.questionnaireVersionId, draft.id))
      .orderBy(questionVersions.displayOrder);

    const plan = planReorder(
      current.map((row) => row.id),
      input.questionIds,
    );
    if (!plan.ok || !plan.order) throw ApiErrors.invalidReorder(plan.reason ?? "unknown");

    await this.db.transaction(async (tx) => {
      for (const { id, displayOrder } of assignDisplayOrder(plan.order!)) {
        await tx
          .update(questionVersions)
          .set({ displayOrder, updatedAt: now })
          .where(eq(questionVersions.id, id));
      }
    });

    return this.questionnaires.loadVersionDetail(this.db, draft).then((detail) => detail.questions);
  }

  // ────────────────────────────────── Options ────────────────────────────────

  async createOption(
    studyId: string,
    questionnaireId: string,
    questionId: string,
    input: CreateQuestionOptionRequest,
    now: Date,
  ): Promise<QuestionOptionResponse> {
    const draft = await this.requireDraft(studyId, questionnaireId);
    const question = await this.requireDraftQuestion(draft.id, questionId);
    if (!requiresOptions(question.type as QuestionType)) {
      throw ApiErrors.questionTypeHasNoOptions(question.type);
    }

    const optionId = await this.db.transaction(async (tx) => {
      // The same lost update as in `createQuestion`, one level down: the
      // question row is the parent whose option ordering must be serialised.
      await tx
        .select({ id: questionVersions.id })
        .from(questionVersions)
        .where(eq(questionVersions.id, questionId))
        .for("update");

      const orderRows = await tx
        .select({ max: sql<number | null>`max(${questionOptions.displayOrder})` })
        .from(questionOptions)
        .where(eq(questionOptions.questionVersionId, questionId));

      const optionKey = generateOptionKey(generateRandomBytes(ENTITY_KEY_BYTES));
      const [inserted] = await tx
        .insert(questionOptions)
        .values({
          questionVersionId: questionId,
          optionKey,
          displayOrder: nextOrder(orderRows[0]?.max),
          valueNumber: input.valueNumber,
          isExclusive: input.isExclusive,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: questionOptions.id });
      if (!inserted) throw new Error("question option insert returned no row");

      await tx.insert(questionOptionTranslations).values(
        Object.entries(input.translations).map(([locale, label]) => ({
          questionOptionId: inserted.id,
          locale,
          label,
          createdAt: now,
          updatedAt: now,
        })),
      );

      return inserted.id;
    });

    return this.loadOption(this.db, optionId);
  }

  async updateOption(
    studyId: string,
    questionnaireId: string,
    questionId: string,
    optionId: string,
    input: UpdateQuestionOptionRequest,
    now: Date,
  ): Promise<QuestionOptionResponse> {
    const draft = await this.requireDraft(studyId, questionnaireId);
    await this.requireDraftQuestion(draft.id, questionId);
    await this.requireOption(questionId, optionId);

    await this.db.transaction(async (tx) => {
      await tx
        .update(questionOptions)
        .set({
          ...(input.valueNumber !== undefined ? { valueNumber: input.valueNumber } : {}),
          ...(input.isExclusive !== undefined ? { isExclusive: input.isExclusive } : {}),
          updatedAt: now,
        })
        .where(eq(questionOptions.id, optionId));

      if (input.translations !== undefined) {
        for (const [locale, label] of Object.entries(input.translations)) {
          await tx
            .insert(questionOptionTranslations)
            .values({ questionOptionId: optionId, locale, label, createdAt: now, updatedAt: now })
            .onConflictDoUpdate({
              target: [
                questionOptionTranslations.questionOptionId,
                questionOptionTranslations.locale,
              ],
              set: { label, updatedAt: now },
            });
        }
      }
    });

    return this.loadOption(this.db, optionId);
  }

  async deleteOption(
    studyId: string,
    questionnaireId: string,
    questionId: string,
    optionId: string,
  ): Promise<void> {
    const draft = await this.requireDraft(studyId, questionnaireId);
    await this.requireDraftQuestion(draft.id, questionId);
    const deleted = await this.db
      .delete(questionOptions)
      .where(
        and(eq(questionOptions.id, optionId), eq(questionOptions.questionVersionId, questionId)),
      )
      .returning({ id: questionOptions.id });
    if (deleted.length === 0) throw ApiErrors.questionOptionNotFound();
  }

  async reorderOptions(
    studyId: string,
    questionnaireId: string,
    questionId: string,
    input: ReorderOptionsRequest,
    now: Date,
  ): Promise<QuestionOptionResponse[]> {
    const draft = await this.requireDraft(studyId, questionnaireId);
    await this.requireDraftQuestion(draft.id, questionId);

    const current = await this.db
      .select({ id: questionOptions.id })
      .from(questionOptions)
      .where(eq(questionOptions.questionVersionId, questionId))
      .orderBy(questionOptions.displayOrder);

    const plan = planReorder(
      current.map((row) => row.id),
      input.optionIds,
    );
    if (!plan.ok || !plan.order) throw ApiErrors.invalidReorder(plan.reason ?? "unknown");

    await this.db.transaction(async (tx) => {
      for (const { id, displayOrder } of assignDisplayOrder(plan.order!)) {
        await tx
          .update(questionOptions)
          .set({ displayOrder, updatedAt: now })
          .where(eq(questionOptions.id, id));
      }
    });

    return this.loadOptionsForQuestion(this.db, questionId);
  }

  // ────────────────────────────────── Helpers ────────────────────────────────

  private async requireDraft(studyId: string, questionnaireId: string) {
    await this.questionnaires.requireQuestionnaire(studyId, questionnaireId);
    const [draft] = await this.db
      .select()
      .from(questionnaireVersions)
      .where(
        and(
          eq(questionnaireVersions.questionnaireId, questionnaireId),
          eq(questionnaireVersions.status, "DRAFT"),
        ),
      )
      .limit(1);
    if (!draft) throw new Error(`questionnaire ${questionnaireId} has no draft version`);
    return draft;
  }

  private async requireDraftQuestion(
    draftVersionId: string,
    questionId: string,
  ): Promise<QuestionVersionRow> {
    const [question] = await this.db
      .select()
      .from(questionVersions)
      .where(
        and(
          eq(questionVersions.id, questionId),
          eq(questionVersions.questionnaireVersionId, draftVersionId),
        ),
      )
      .limit(1);
    if (!question) throw ApiErrors.questionNotFound();
    return question;
  }

  private async requireOption(questionId: string, optionId: string): Promise<QuestionOptionRow> {
    const [option] = await this.db
      .select()
      .from(questionOptions)
      .where(
        and(eq(questionOptions.id, optionId), eq(questionOptions.questionVersionId, questionId)),
      )
      .limit(1);
    if (!option) throw ApiErrors.questionOptionNotFound();
    return option;
  }

  private async loadQuestion(db: Database, questionId: string): Promise<QuestionResponse> {
    const [question] = await db
      .select()
      .from(questionVersions)
      .where(eq(questionVersions.id, questionId))
      .limit(1);
    if (!question) throw ApiErrors.questionNotFound();

    const translations = await db
      .select()
      .from(questionVersionTranslations)
      .where(eq(questionVersionTranslations.questionVersionId, questionId));
    const options = await this.loadOptionsForQuestion(db, questionId);

    return {
      id: question.id,
      questionKey: question.questionKey,
      type: question.type as QuestionType,
      isRequired: question.isRequired,
      pageIndex: question.pageIndex,
      displayOrder: question.displayOrder,
      config: question.config as QuestionResponse["config"],
      translations: toLocaleRecord(translations, (t) => t.text),
      options,
    };
  }

  private async loadOption(db: Database, optionId: string): Promise<QuestionOptionResponse> {
    const [option] = await db
      .select()
      .from(questionOptions)
      .where(eq(questionOptions.id, optionId))
      .limit(1);
    if (!option) throw ApiErrors.questionOptionNotFound();
    const translations = await db
      .select()
      .from(questionOptionTranslations)
      .where(eq(questionOptionTranslations.questionOptionId, optionId));
    return toOptionResponse(option, translations);
  }

  private async loadOptionsForQuestion(
    db: Database,
    questionId: string,
  ): Promise<QuestionOptionResponse[]> {
    const options = await db
      .select()
      .from(questionOptions)
      .where(eq(questionOptions.questionVersionId, questionId))
      .orderBy(questionOptions.displayOrder);
    if (options.length === 0) return [];

    const translations = await db
      .select()
      .from(questionOptionTranslations)
      .where(
        inArray(
          questionOptionTranslations.questionOptionId,
          options.map((o) => o.id),
        ),
      );
    const byOption = new Map<string, Array<(typeof translations)[number]>>();
    for (const t of translations) {
      const bucket = byOption.get(t.questionOptionId);
      if (bucket) bucket.push(t);
      else byOption.set(t.questionOptionId, [t]);
    }

    return options.map((option) => toOptionResponse(option, byOption.get(option.id) ?? []));
  }
}

/** The next free `display_order`; 0 when the collection is empty. */
function nextOrder(currentMax: number | null | undefined): number {
  return currentMax === null || currentMax === undefined ? 0 : currentMax + 1;
}
