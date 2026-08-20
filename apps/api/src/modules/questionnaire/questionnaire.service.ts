import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  questionOptionTranslations,
  questionOptions,
  questionVersionTranslations,
  questionVersions,
  questionnaireVersions,
  questionnaires,
  type Database,
  type QuestionOptionRow,
  type QuestionVersionRow,
  type QuestionnaireVersionRow,
} from "@lpr/db";
import { canPublishQuestionnaire, type PublishEligibility } from "@lpr/domain";
import type {
  CreateQuestionnaireRequest,
  Locale,
  QuestionConfig,
  QuestionOptionResponse,
  QuestionResponse,
  QuestionType,
  QuestionnaireDetail,
  QuestionnaireSummary,
  QuestionnaireVersionDetail,
  QuestionnaireVersionStatus,
  QuestionnaireVersionSummary,
  ResearcherProfile,
  UpdateQuestionnaireRequest,
} from "@lpr/contracts";
import { ApiErrors, type ApiException } from "../../common/api-error.js";
import { DATABASE } from "../database/database.module.js";
import { AuditService } from "../audit/audit.service.js";
import type { RequestContext } from "../auth/session.service.js";

/**
 * Questionnaire and questionnaire-version orchestration (PLAN.md Phase 3).
 *
 * Question and option CRUD live in `QuestionService` — this service owns the
 * questionnaire shell, reading assembled versions, and the publish
 * deep-copy, which is the one operation here with research-integrity stakes:
 * once it commits, the new `PUBLISHED` row is exactly what a participant will
 * see for the life of that version.
 */
@Injectable()
export class QuestionnaireService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly audit: AuditService,
  ) {}

  async list(studyId: string): Promise<QuestionnaireSummary[]> {
    const rows = await this.db
      .select()
      .from(questionnaires)
      .where(eq(questionnaires.studyId, studyId))
      .orderBy(desc(questionnaires.createdAt));
    if (rows.length === 0) return [];

    const questionnaireIds = rows.map((row) => row.id);
    const versions = await this.db
      .select()
      .from(questionnaireVersions)
      .where(inArray(questionnaireVersions.questionnaireId, questionnaireIds));
    const countByVersion = await this.questionCountsByVersion(versions.map((v) => v.id));
    const versionsByQuestionnaire = groupBy(versions, (v) => v.questionnaireId);

    return rows.map((row) => {
      const versionsForRow = versionsByQuestionnaire.get(row.id) ?? [];
      const draft = versionsForRow.find((v) => v.status === "DRAFT");
      const published = latestPublished(versionsForRow);
      if (!draft) {
        // Invariant: `create` always inserts a draft in the same transaction
        // as the questionnaire, and nothing in Phase 3 ever removes it.
        throw new Error(`questionnaire ${row.id} has no draft version`);
      }
      return {
        id: row.id,
        studyId: row.studyId,
        name: row.name,
        description: row.description,
        draft: toVersionSummary(draft, countByVersion.get(draft.id) ?? 0),
        latestPublished: published
          ? toVersionSummary(published, countByVersion.get(published.id) ?? 0)
          : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  async get(studyId: string, questionnaireId: string): Promise<QuestionnaireDetail> {
    const row = await this.requireQuestionnaire(studyId, questionnaireId);
    const versions = await this.db
      .select()
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.questionnaireId, questionnaireId));

    const draft = versions.find((v) => v.status === "DRAFT");
    if (!draft) throw new Error(`questionnaire ${questionnaireId} has no draft version`);

    const published = versions
      .filter((v) => v.status !== "DRAFT")
      .sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0));

    const draftDetail = await this.loadVersionDetail(this.db, draft);
    const countByVersion = await this.questionCountsByVersion(published.map((v) => v.id));
    const publishedSummaries = published.map((version) =>
      toVersionSummary(version, countByVersion.get(version.id) ?? 0),
    );

    return {
      id: row.id,
      studyId: row.studyId,
      name: row.name,
      description: row.description,
      draft: draftDetail,
      publishedVersions: publishedSummaries,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async getVersion(
    studyId: string,
    questionnaireId: string,
    versionId: string,
  ): Promise<QuestionnaireVersionDetail> {
    await this.requireQuestionnaire(studyId, questionnaireId);
    const [version] = await this.db
      .select()
      .from(questionnaireVersions)
      .where(
        and(
          eq(questionnaireVersions.id, versionId),
          eq(questionnaireVersions.questionnaireId, questionnaireId),
        ),
      )
      .limit(1);
    if (!version) throw ApiErrors.questionnaireNotFound();
    return this.loadVersionDetail(this.db, version);
  }

  /** Creates the questionnaire and its initial DRAFT version atomically. */
  async create(
    actor: ResearcherProfile,
    studyId: string,
    input: CreateQuestionnaireRequest,
    now: Date,
    context: RequestContext,
  ): Promise<QuestionnaireDetail> {
    const { questionnaire, draft } = await this.db.transaction(async (tx) => {
      const [insertedQuestionnaire] = await tx
        .insert(questionnaires)
        .values({
          studyId,
          name: input.name,
          description: input.description,
          createdBy: actor.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!insertedQuestionnaire) throw new Error("questionnaire insert returned no row");

      const [insertedDraft] = await tx
        .insert(questionnaireVersions)
        .values({
          questionnaireId: insertedQuestionnaire.id,
          status: "DRAFT",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!insertedDraft) throw new Error("questionnaire version insert returned no row");

      return { questionnaire: insertedQuestionnaire, draft: insertedDraft };
    });

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId,
      action: "questionnaire.created",
      entityType: "questionnaire",
      entityId: questionnaire.id,
      metadata: { name: questionnaire.name },
      context,
      occurredAt: now,
    });

    return {
      id: questionnaire.id,
      studyId: questionnaire.studyId,
      name: questionnaire.name,
      description: questionnaire.description,
      draft: await this.loadVersionDetail(this.db, draft),
      publishedVersions: [],
      createdAt: questionnaire.createdAt.toISOString(),
      updatedAt: questionnaire.updatedAt.toISOString(),
    };
  }

  /**
   * Renames or re-describes the questionnaire. Allowed regardless of the
   * draft or any published version's state — these are researcher-facing
   * labels only, never part of what a participant is shown.
   */
  async update(
    actor: ResearcherProfile,
    studyId: string,
    questionnaireId: string,
    input: UpdateQuestionnaireRequest,
    now: Date,
    context: RequestContext,
  ): Promise<QuestionnaireSummary> {
    const [updated] = await this.db
      .update(questionnaires)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        updatedAt: now,
      })
      .where(and(eq(questionnaires.id, questionnaireId), eq(questionnaires.studyId, studyId)))
      .returning();
    if (!updated) throw ApiErrors.questionnaireNotFound();

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId,
      action: "questionnaire.updated",
      entityType: "questionnaire",
      entityId: questionnaireId,
      metadata: { fields: Object.keys(input) },
      context,
      occurredAt: now,
    });

    const versions = await this.db
      .select()
      .from(questionnaireVersions)
      .where(eq(questionnaireVersions.questionnaireId, questionnaireId));
    const draft = versions.find((v) => v.status === "DRAFT");
    if (!draft) throw new Error(`questionnaire ${questionnaireId} has no draft version`);
    const published = latestPublished(versions);

    const countByVersion = await this.questionCountsByVersion(
      published ? [draft.id, published.id] : [draft.id],
    );

    return {
      id: updated.id,
      studyId: updated.studyId,
      name: updated.name,
      description: updated.description,
      draft: toVersionSummary(draft, countByVersion.get(draft.id) ?? 0),
      latestPublished: published
        ? toVersionSummary(published, countByVersion.get(published.id) ?? 0)
        : null,
      createdAt: updated.createdAt.toISOString(),
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Publish: deep-copy the draft's current questions, translations, and
   * options into a new, immutable `PUBLISHED` version. The draft itself is
   * never touched, which is what leaves it free to keep accumulating edits
   * toward whatever gets published next (STRUCTURE.md §6).
   *
   * Row-by-row rather than one bulk statement per table: publishing is a rare,
   * deliberate action on at most a few dozen questions, and the loop makes the
   * id mapping between an old question/option and its copy explicit instead
   * of relying on RETURNING preserving VALUES-list order.
   */
  async publish(
    actor: ResearcherProfile,
    studyId: string,
    questionnaireId: string,
    now: Date,
    context: RequestContext,
  ): Promise<QuestionnaireVersionDetail> {
    await this.requireQuestionnaire(studyId, questionnaireId);

    const published = await this.db.transaction(async (tx) => {
      const [draft] = await tx
        .select()
        .from(questionnaireVersions)
        .where(
          and(
            eq(questionnaireVersions.questionnaireId, questionnaireId),
            eq(questionnaireVersions.status, "DRAFT"),
          ),
        )
        .for("update");
      if (!draft) throw ApiErrors.questionnaireNotFound();

      const draftQuestions = await tx
        .select()
        .from(questionVersions)
        .where(eq(questionVersions.questionnaireVersionId, draft.id))
        .orderBy(questionVersions.displayOrder);

      const optionCounts = await this.optionCountsByQuestion(
        tx,
        draftQuestions.map((q) => q.id),
      );
      const eligibility = canPublishQuestionnaire(
        draftQuestions.map((q) => ({
          type: q.type as QuestionType,
          optionCount: optionCounts.get(q.id) ?? 0,
          config: q.config,
        })),
      );
      if (!eligibility.ok) throw publishRefusal(eligibility);

      const highestRows = await tx
        .select({ max: sql<number | null>`max(${questionnaireVersions.versionNumber})` })
        .from(questionnaireVersions)
        .where(
          and(
            eq(questionnaireVersions.questionnaireId, questionnaireId),
            eq(questionnaireVersions.status, "PUBLISHED"),
          ),
        );
      const nextVersionNumber = (highestRows[0]?.max ?? 0) + 1;

      const [publishedVersion] = await tx
        .insert(questionnaireVersions)
        .values({
          questionnaireId,
          status: "PUBLISHED",
          versionNumber: nextVersionNumber,
          publishedAt: now,
          publishedBy: actor.id,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!publishedVersion) throw new Error("questionnaire version insert returned no row");

      for (const question of draftQuestions) {
        const [newQuestion] = await tx
          .insert(questionVersions)
          .values({
            questionnaireVersionId: publishedVersion.id,
            questionKey: question.questionKey,
            type: question.type,
            isRequired: question.isRequired,
            pageIndex: question.pageIndex,
            displayOrder: question.displayOrder,
            config: question.config,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        if (!newQuestion) throw new Error("question version insert returned no row");

        const translations = await tx
          .select()
          .from(questionVersionTranslations)
          .where(eq(questionVersionTranslations.questionVersionId, question.id));
        if (translations.length > 0) {
          await tx.insert(questionVersionTranslations).values(
            translations.map((t) => ({
              questionVersionId: newQuestion.id,
              locale: t.locale,
              text: t.text,
              createdAt: now,
              updatedAt: now,
            })),
          );
        }

        const options = await tx
          .select()
          .from(questionOptions)
          .where(eq(questionOptions.questionVersionId, question.id))
          .orderBy(questionOptions.displayOrder);

        for (const option of options) {
          const [newOption] = await tx
            .insert(questionOptions)
            .values({
              questionVersionId: newQuestion.id,
              optionKey: option.optionKey,
              displayOrder: option.displayOrder,
              valueNumber: option.valueNumber,
              isExclusive: option.isExclusive,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          if (!newOption) throw new Error("question option insert returned no row");

          const optionTranslations = await tx
            .select()
            .from(questionOptionTranslations)
            .where(eq(questionOptionTranslations.questionOptionId, option.id));
          if (optionTranslations.length > 0) {
            await tx.insert(questionOptionTranslations).values(
              optionTranslations.map((t) => ({
                questionOptionId: newOption.id,
                locale: t.locale,
                label: t.label,
                createdAt: now,
                updatedAt: now,
              })),
            );
          }
        }
      }

      return { version: publishedVersion, questionCount: draftQuestions.length };
    });

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: actor.id,
      actorLabel: actor.email,
      studyId,
      action: "questionnaire.version.published",
      entityType: "questionnaire_version",
      entityId: published.version.id,
      metadata: {
        questionnaireId,
        versionNumber: published.version.versionNumber,
        questionCount: published.questionCount,
      },
      context,
      occurredAt: now,
    });

    return this.loadVersionDetail(this.db, published.version);
  }

  // ────────────────────────────────── Helpers ────────────────────────────────

  async requireQuestionnaire(
    studyId: string,
    questionnaireId: string,
  ): Promise<typeof questionnaires.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(questionnaires)
      .where(and(eq(questionnaires.id, questionnaireId), eq(questionnaires.studyId, studyId)))
      .limit(1);
    if (!row) throw ApiErrors.questionnaireNotFound();
    return row;
  }

  /**
   * Question counts for a set of versions, in ONE grouped query.
   *
   * Every caller that needs a count needs several — a questionnaire's draft
   * plus each of its published versions — so there is deliberately no
   * single-version variant to reach for: one existed and turned `get()` into a
   * query per published version, which grows with the study's history.
   */
  private async questionCountsByVersion(versionIds: string[]): Promise<Map<string, number>> {
    if (versionIds.length === 0) return new Map();
    const rows = await this.db
      .select({
        versionId: questionVersions.questionnaireVersionId,
        count: sql<number>`count(*)::int`,
      })
      .from(questionVersions)
      .where(inArray(questionVersions.questionnaireVersionId, versionIds))
      .groupBy(questionVersions.questionnaireVersionId);
    return new Map(rows.map((row) => [row.versionId, row.count]));
  }

  /** Option counts per question — named for what it counts, which is options. */
  private async optionCountsByQuestion(
    tx: Database,
    questionIds: string[],
  ): Promise<Map<string, number>> {
    if (questionIds.length === 0) return new Map();
    const rows = await tx
      .select({ questionId: questionOptions.questionVersionId, count: sql<number>`count(*)::int` })
      .from(questionOptions)
      .where(inArray(questionOptions.questionVersionId, questionIds))
      .groupBy(questionOptions.questionVersionId);
    return new Map(rows.map((row) => [row.questionId, row.count]));
  }

  /** Assembles a full version — every question, its translations, and its options. */
  async loadVersionDetail(
    db: Database,
    version: QuestionnaireVersionRow,
  ): Promise<QuestionnaireVersionDetail> {
    const questions = await db
      .select()
      .from(questionVersions)
      .where(eq(questionVersions.questionnaireVersionId, version.id))
      .orderBy(questionVersions.displayOrder);

    const questionResponses =
      questions.length === 0 ? [] : await this.assembleQuestions(db, questions);

    return {
      id: version.id,
      questionnaireId: version.questionnaireId,
      status: version.status as QuestionnaireVersionStatus,
      versionNumber: version.versionNumber,
      questionCount: questions.length,
      publishedAt: version.publishedAt?.toISOString() ?? null,
      createdAt: version.createdAt.toISOString(),
      updatedAt: version.updatedAt.toISOString(),
      questions: questionResponses,
    };
  }

  private async assembleQuestions(
    db: Database,
    questions: QuestionVersionRow[],
  ): Promise<QuestionResponse[]> {
    const questionIds = questions.map((q) => q.id);

    const translations = await db
      .select()
      .from(questionVersionTranslations)
      .where(inArray(questionVersionTranslations.questionVersionId, questionIds));
    const translationsByQuestion = groupBy(translations, (t) => t.questionVersionId);

    const options = await db
      .select()
      .from(questionOptions)
      .where(inArray(questionOptions.questionVersionId, questionIds))
      .orderBy(questionOptions.displayOrder);
    const optionsByQuestion = groupBy(options, (o) => o.questionVersionId);

    const optionIds = options.map((o) => o.id);
    const optionTranslations =
      optionIds.length === 0
        ? []
        : await db
            .select()
            .from(questionOptionTranslations)
            .where(inArray(questionOptionTranslations.questionOptionId, optionIds));
    const optionTranslationsByOption = groupBy(optionTranslations, (t) => t.questionOptionId);

    return questions.map((question) => ({
      id: question.id,
      questionKey: question.questionKey,
      type: question.type as QuestionType,
      isRequired: question.isRequired,
      pageIndex: question.pageIndex,
      displayOrder: question.displayOrder,
      config: question.config as QuestionConfig,
      translations: toLocaleRecord(translationsByQuestion.get(question.id) ?? [], (t) => t.text),
      options: (optionsByQuestion.get(question.id) ?? []).map((option) =>
        toOptionResponse(option, optionTranslationsByOption.get(option.id) ?? []),
      ),
    }));
  }
}

/**
 * Turns a publish refusal into the error the client branches on.
 *
 * One code per blocking condition, never a shared `CONFLICT`. Publishing is
 * irreversible, so the researcher has to be told exactly what to fix — and a
 * frontend with only `CONFLICT` to go on ends up rendering the server's
 * English `message`, which `api-error.ts` forbids in a bilingual interface.
 */
function publishRefusal(eligibility: PublishEligibility): ApiException {
  const position = (eligibility.questionIndex ?? 0) + 1;

  switch (eligibility.reason) {
    case "INSUFFICIENT_OPTIONS":
      return ApiErrors.questionOptionsRequired(position, eligibility.requiredOptions ?? 2);
    case "SELECTION_BOUNDS_EXCEED_OPTIONS":
      return ApiErrors.questionSelectionBoundsUnsatisfiable(position);
    case "EMPTY_QUESTIONNAIRE":
    default:
      return ApiErrors.questionnaireEmpty();
  }
}

function toVersionSummary(
  version: QuestionnaireVersionRow,
  questionCount: number,
): QuestionnaireVersionSummary {
  return {
    id: version.id,
    status: version.status as QuestionnaireVersionStatus,
    versionNumber: version.versionNumber,
    questionCount,
    publishedAt: version.publishedAt?.toISOString() ?? null,
  };
}

export function toOptionResponse(
  option: QuestionOptionRow,
  translations: Array<{ locale: string; label: string }>,
): QuestionOptionResponse {
  return {
    id: option.id,
    optionKey: option.optionKey,
    displayOrder: option.displayOrder,
    valueNumber: option.valueNumber,
    isExclusive: option.isExclusive,
    translations: toLocaleRecord(translations, (t) => t.label),
  };
}

export function toLocaleRecord<T extends { locale: string }>(
  rows: T[],
  extract: (row: T) => string,
): Record<Locale, string> {
  const record: Record<string, string> = {};
  for (const row of rows) record[row.locale] = extract(row);
  return record as Record<Locale, string>;
}

function latestPublished(versions: QuestionnaireVersionRow[]): QuestionnaireVersionRow | undefined {
  return versions
    .filter((v) => v.status === "PUBLISHED")
    .sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0))[0];
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return map;
}
