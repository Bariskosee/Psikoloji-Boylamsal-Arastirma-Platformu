import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import {
  participantSessions,
  participants,
  protocolSteps,
  questionOptions,
  questionOptionTranslations,
  questionVersionTranslations,
  questionVersions,
  questionnaireVersions,
  questionnaires,
  responseHistory,
  responseOptionSelections,
  responses,
  sessionSubmissions,
  type Database,
} from "@lpr/db";
import {
  canComplete,
  canWriteAnswer,
  countsAsAnswered,
  decideRevision,
  validateAnswer,
  type SessionStatus,
  type SubmittedAnswer,
} from "@lpr/domain";
import type {
  AnswerOutcome,
  CompleteSessionResponse,
  Locale,
  QuestionType,
  RuntimeQuestion,
  SaveAnswerRequest,
  SaveAnswersResponse,
  SavedAnswer,
  SessionDetail,
  SessionListResponse,
  SessionStatusValue,
} from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { DATABASE } from "../database/database.module.js";
import { MaterialisationService } from "../scheduling/materialisation.service.js";

type SessionRow = typeof participantSessions.$inferSelect;

/**
 * The questionnaire runtime (PLAN.md Phase 6).
 *
 * Three operations: read a session with its questions and saved answers,
 * autosave an answer, and complete.
 *
 * ── The rules that do not bend ──────────────────────────────────────────────
 * Every session is resolved BY PARTICIPANT: the id in the path is matched
 * against the credential's participant in the same query, so a participant
 * cannot read or write another's session by guessing an id.
 *
 * Every window decision uses the server's clock. A client cannot extend an
 * expired window by any means, including a wrong device clock, because no
 * client-supplied instant reaches the decision.
 *
 * Required-question validation is server-side. The client runs the same domain
 * function for immediate feedback; this is the authority.
 */
@Injectable()
export class SessionService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly materialisation: MaterialisationService,
  ) {}

  async list(participantId: string): Promise<SessionListResponse> {
    const rows = await this.db
      .select({
        session: participantSessions,
        stepKey: protocolSteps.stepKey,
        questionnaireName: questionnaires.name,
      })
      .from(participantSessions)
      .innerJoin(protocolSteps, eq(protocolSteps.id, participantSessions.protocolStepId))
      .innerJoin(
        questionnaireVersions,
        eq(questionnaireVersions.id, participantSessions.questionnaireVersionId),
      )
      .innerJoin(questionnaires, eq(questionnaires.id, questionnaireVersions.questionnaireId))
      .where(eq(participantSessions.participantId, participantId))
      .orderBy(asc(participantSessions.availableFrom));

    return {
      sessions: rows.map((row) => ({
        id: row.session.id,
        status: row.session.status as SessionStatusValue,
        stepKey: row.stepKey,
        occurrenceIndex: row.session.occurrenceIndex,
        availableFrom: row.session.availableFrom?.toISOString() ?? null,
        availableUntil: row.session.availableUntil?.toISOString() ?? null,
        questionnaireName: row.questionnaireName,
      })),
    };
  }

  async detail(participantId: string, sessionId: string, now: Date): Promise<SessionDetail> {
    const session = await this.requireOwnSession(participantId, sessionId);

    const participant = (
      await this.db
        .select({ locale: participants.locale })
        .from(participants)
        .where(eq(participants.id, participantId))
        .limit(1)
    )[0];
    const locale = (participant?.locale ?? "en") as Locale;

    const step = (
      await this.db
        .select({ stepKey: protocolSteps.stepKey })
        .from(protocolSteps)
        .where(eq(protocolSteps.id, session.protocolStepId))
        .limit(1)
    )[0];

    const questions = await this.loadQuestions(session.questionnaireVersionId, locale);
    const answers = await this.loadAnswers(session.id);

    return {
      id: session.id,
      status: session.status as SessionStatusValue,
      stepKey: step?.stepKey ?? "",
      occurrenceIndex: session.occurrenceIndex,
      locale,
      availableFrom: session.availableFrom?.toISOString() ?? null,
      availableUntil: session.availableUntil?.toISOString() ?? null,
      serverTime: now.toISOString(),
      questions,
      answers,
      pageCount: questions.reduce((max, question) => Math.max(max, question.pageIndex + 1), 0),
    };
  }

  /**
   * Autosave a batch of answers.
   *
   * One transaction with the session row LOCKED, so a concurrent completion
   * cannot land between the window check and the write — the check would pass
   * against a session that is completed by the time the row is inserted.
   *
   * A batch is what an outbox replays after a reconnection, and it routinely
   * mixes new answers with ones the server already has. Each answer therefore
   * gets its own outcome rather than the batch sharing one: failing the whole
   * request on the duplicates would leave the outbox unable to drain.
   */
  async saveAnswers(
    participantId: string,
    sessionId: string,
    incoming: readonly SaveAnswerRequest[],
    now: Date,
  ): Promise<SaveAnswersResponse> {
    return this.db.transaction(async (tx) => {
      const session = await lockSession(tx, participantId, sessionId);

      const verdict = canWriteAnswer(
        {
          status: session.status as SessionStatus,
          availableFrom: session.availableFrom,
          availableUntil: session.availableUntil,
        },
        now,
      );
      if (!verdict.allowed) throw writeRefusal(verdict.reason);

      const questions = await this.loadQuestionShapes(tx, session.questionnaireVersionId);

      const results: SaveAnswersResponse["results"] = [];

      for (const answer of incoming) {
        const question = questions.get(answer.questionVersionId);
        // A question id from another questionnaire version would otherwise be
        // stored against a session it does not belong to.
        if (!question) throw ApiErrors.questionNotFound();

        const submitted: SubmittedAnswer = {
          valueNumber: answer.valueNumber,
          valueText: answer.valueText,
          selectedOptionIds: answer.selectedOptionIds,
        };

        const validation = validateAnswer(
          {
            type: question.type,
            isRequired: question.isRequired,
            optionIds: question.optionIds,
            config: question.config,
          },
          submitted,
        );
        if (!validation.ok) {
          await recordHistory(tx, session.id, answer, "REJECTED", now);
          throw ApiErrors.answerRejected(validation.problem);
        }

        const existing = (
          await tx
            .select()
            .from(responses)
            .where(
              and(
                eq(responses.sessionId, session.id),
                eq(responses.questionVersionId, answer.questionVersionId),
              ),
            )
            .limit(1)
        )[0];

        const decision = decideRevision(existing?.clientRevision ?? null, answer.clientRevision);
        await recordHistory(tx, session.id, answer, decision, now);

        if (decision === "APPLY") {
          await this.writeAnswer(
            tx,
            session.id,
            participantId,
            answer,
            validation.valueKind,
            now,
            existing?.id,
          );
        }

        results.push({
          questionVersionId: answer.questionVersionId,
          outcome: decision as AnswerOutcome,
          storedRevision:
            decision === "APPLY" ? answer.clientRevision : (existing?.clientRevision ?? 0),
        });
      }

      // The first accepted answer starts the session. Done after the writes so
      // a rejected batch cannot flip the status.
      let status = session.status;
      if (verdict.transitionTo === "STARTED" && results.some((r) => r.outcome === "APPLY")) {
        await tx
          .update(participantSessions)
          .set({ status: "STARTED", startedAt: session.startedAt ?? now })
          .where(eq(participantSessions.id, session.id));
        status = "STARTED";
      }

      return {
        results,
        status: status as SessionStatusValue,
        serverTime: now.toISOString(),
      };
    });
  }

  /**
   * Complete the session.
   *
   * Idempotent under concurrency, by construction rather than by checking
   * first: the row is locked, and `session_submissions.session_id` is unique.
   * Ten simultaneous calls serialise on the lock; the first writes the
   * submission and the rest find the session already `COMPLETED` and return it.
   */
  async complete(
    participantId: string,
    sessionId: string,
    now: Date,
  ): Promise<CompleteSessionResponse> {
    return this.db.transaction(async (tx) => {
      const session = await lockSession(tx, participantId, sessionId);

      if (session.status === "COMPLETED") {
        const existing = (
          await tx
            .select()
            .from(sessionSubmissions)
            .where(eq(sessionSubmissions.sessionId, session.id))
            .limit(1)
        )[0];
        if (!existing) throw new Error(`completed session ${session.id} has no submission`);

        return {
          sessionId: session.id,
          completedAt: existing.completedAt.toISOString(),
          answeredCount: existing.answeredCount,
          requiredCount: existing.requiredCount,
          alreadyCompleted: true,
        };
      }

      const questions = await this.loadQuestionShapes(tx, session.questionnaireVersionId);
      const stored = await tx.select().from(responses).where(eq(responses.sessionId, session.id));

      const selections = await this.loadSelections(
        tx,
        stored.map((row) => row.id),
      );

      // "Answered" is not "has a row": an empty string and an empty selection
      // are valid writes that do not satisfy a required question.
      const answeredKeys: string[] = [];
      for (const response of stored) {
        const question = questions.get(response.questionVersionId);
        if (!question) continue;
        const answered = countsAsAnswered(question.type, {
          valueNumber: response.valueNumber,
          valueText: response.valueText,
          selectedOptionIds: selections.get(response.id) ?? [],
        });
        if (answered) answeredKeys.push(question.questionKey);
      }

      const requiredKeys = [...questions.values()]
        .filter((question) => question.isRequired)
        .map((question) => question.questionKey);

      const verdict = canComplete(
        {
          status: session.status as SessionStatus,
          availableFrom: session.availableFrom,
          availableUntil: session.availableUntil,
        },
        now,
        requiredKeys,
        answeredKeys,
      );
      if (!verdict.allowed) {
        if (verdict.reason === "REQUIRED_UNANSWERED") {
          throw ApiErrors.requiredQuestionsUnanswered(verdict.missing ?? []);
        }
        throw writeRefusal(verdict.reason as never);
      }

      await tx
        .update(participantSessions)
        .set({ status: "COMPLETED", completedAt: now })
        .where(eq(participantSessions.id, session.id));

      /**
       * Anything waiting on this step becomes schedulable, in THIS transaction.
       *
       * Doing it afterwards — or from a job — would leave a window in which the
       * participant's baseline is complete and the follow-up it implies does
       * not exist. A crash there is invisible: nothing records that the
       * propagation was owed, which is exactly the failure ADR-005 exists to
       * make impossible for everything else.
       */
      await this.materialisation.propagate(tx, session.id, session.protocolStepId, now, now);

      const submission = (
        await tx
          .insert(sessionSubmissions)
          .values({
            sessionId: session.id,
            completedAt: now,
            answeredCount: answeredKeys.length,
            requiredCount: requiredKeys.length,
            contentHash: contentHash(stored, selections),
            createdAt: now,
          })
          .returning()
      )[0];
      if (!submission) throw new Error("session submission insert returned no row");

      return {
        sessionId: session.id,
        completedAt: submission.completedAt.toISOString(),
        answeredCount: submission.answeredCount,
        requiredCount: submission.requiredCount,
        alreadyCompleted: false,
      };
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async requireOwnSession(participantId: string, sessionId: string): Promise<SessionRow> {
    const row = (
      await this.db
        .select()
        .from(participantSessions)
        .where(
          and(
            eq(participantSessions.id, sessionId),
            // Ownership is part of the QUERY, never a check afterwards.
            eq(participantSessions.participantId, participantId),
          ),
        )
        .limit(1)
    )[0];
    if (!row) throw ApiErrors.sessionNotFound();
    return row;
  }

  private async loadQuestions(
    questionnaireVersionId: string,
    locale: Locale,
  ): Promise<RuntimeQuestion[]> {
    const rows = await this.db
      .select()
      .from(questionVersions)
      .where(eq(questionVersions.questionnaireVersionId, questionnaireVersionId))
      .orderBy(asc(questionVersions.pageIndex), asc(questionVersions.displayOrder));
    if (rows.length === 0) return [];

    const ids = rows.map((row) => row.id);

    const texts = await this.db
      .select()
      .from(questionVersionTranslations)
      .where(inArray(questionVersionTranslations.questionVersionId, ids));

    const options = await this.db
      .select()
      .from(questionOptions)
      .where(inArray(questionOptions.questionVersionId, ids))
      .orderBy(asc(questionOptions.displayOrder));

    const optionLabels =
      options.length === 0
        ? []
        : await this.db
            .select()
            .from(questionOptionTranslations)
            .where(
              inArray(
                questionOptionTranslations.questionOptionId,
                options.map((option) => option.id),
              ),
            );

    /**
     * The participant's locale, then any other.
     *
     * A question with no translation in their language must still render:
     * showing the other language is bad, showing an empty question is worse —
     * it would be silently unanswerable and would corrupt the response.
     */
    const pick = <T extends { locale: string }>(candidates: T[]): T | undefined =>
      candidates.find((row) => row.locale === locale) ?? candidates[0];

    return rows.map((row) => {
      const text = pick(texts.filter((t) => t.questionVersionId === row.id));
      const mine = options.filter((option) => option.questionVersionId === row.id);

      return {
        id: row.id,
        questionKey: row.questionKey,
        type: row.type as QuestionType,
        isRequired: row.isRequired,
        pageIndex: row.pageIndex,
        displayOrder: row.displayOrder,
        text: text?.text ?? "",
        config: row.config as Record<string, unknown>,
        options: mine.map((option) => {
          const label = pick(optionLabels.filter((l) => l.questionOptionId === option.id));
          return {
            id: option.id,
            optionKey: option.optionKey,
            label: label?.label ?? "",
            isExclusive: option.isExclusive,
          };
        }),
      };
    });
  }

  private async loadAnswers(sessionId: string): Promise<SavedAnswer[]> {
    const rows = await this.db.select().from(responses).where(eq(responses.sessionId, sessionId));
    if (rows.length === 0) return [];

    const selections = await this.loadSelections(
      this.db,
      rows.map((row) => row.id),
    );

    return rows.map((row) => ({
      questionVersionId: row.questionVersionId,
      valueNumber: row.valueNumber,
      valueText: row.valueText,
      selectedOptionIds: selections.get(row.id) ?? [],
      clientRevision: row.clientRevision,
      answeredAt: row.answeredAt.toISOString(),
    }));
  }

  private async loadSelections(
    db: Database,
    responseIds: string[],
  ): Promise<Map<string, string[]>> {
    if (responseIds.length === 0) return new Map();

    const rows = await db
      .select()
      .from(responseOptionSelections)
      .where(inArray(responseOptionSelections.responseId, responseIds));

    const byResponse = new Map<string, string[]>();
    for (const row of rows) {
      const list = byResponse.get(row.responseId) ?? [];
      list.push(row.questionOptionId);
      byResponse.set(row.responseId, list);
    }
    return byResponse;
  }

  private async loadQuestionShapes(
    db: Database,
    questionnaireVersionId: string,
  ): Promise<Map<string, QuestionShape>> {
    const rows = await db
      .select()
      .from(questionVersions)
      .where(eq(questionVersions.questionnaireVersionId, questionnaireVersionId));
    if (rows.length === 0) return new Map();

    const options = await db
      .select()
      .from(questionOptions)
      .where(
        inArray(
          questionOptions.questionVersionId,
          rows.map((row) => row.id),
        ),
      );

    return new Map(
      rows.map((row) => [
        row.id,
        {
          id: row.id,
          questionKey: row.questionKey,
          type: row.type as QuestionType,
          isRequired: row.isRequired,
          config: row.config as Record<string, unknown>,
          optionIds: options
            .filter((option) => option.questionVersionId === row.id)
            .map((option) => option.id),
        },
      ]),
    );
  }

  private async writeAnswer(
    tx: Database,
    sessionId: string,
    participantId: string,
    answer: SaveAnswerRequest,
    valueKind: string,
    now: Date,
    existingId: string | undefined,
  ): Promise<void> {
    let responseId = existingId;

    if (responseId === undefined) {
      const inserted = (
        await tx
          .insert(responses)
          .values({
            sessionId,
            participantId,
            questionVersionId: answer.questionVersionId,
            valueKind,
            valueNumber: answer.valueNumber,
            valueText: answer.valueText,
            answeredAt: now,
            clientRevision: answer.clientRevision,
            createdAt: now,
            updatedAt: now,
          })
          .returning()
      )[0];
      if (!inserted) throw new Error("response insert returned no row");
      responseId = inserted.id;
    } else {
      await tx
        .update(responses)
        .set({
          valueKind,
          valueNumber: answer.valueNumber,
          valueText: answer.valueText,
          answeredAt: now,
          clientRevision: answer.clientRevision,
        })
        .where(eq(responses.id, responseId));

      // Selections are replaced wholesale: a diff would have to decide what a
      // missing id means, and "the answer is now exactly this set" is the only
      // reading that matches what the participant did.
      await tx
        .delete(responseOptionSelections)
        .where(eq(responseOptionSelections.responseId, responseId));
    }

    if (answer.selectedOptionIds.length > 0) {
      await tx.insert(responseOptionSelections).values(
        answer.selectedOptionIds.map((questionOptionId) => ({
          responseId: responseId as string,
          questionOptionId,
          createdAt: now,
        })),
      );
    }
  }
}

interface QuestionShape {
  readonly id: string;
  readonly questionKey: string;
  readonly type: QuestionType;
  readonly isRequired: boolean;
  readonly config: Record<string, unknown>;
  readonly optionIds: string[];
}

/**
 * Lock the session row for the duration of the transaction.
 *
 * `FOR UPDATE` is what makes concurrent autosaves and completions serialise.
 * Without it, two requests could both read `STARTED`, both pass their checks,
 * and both act — which for completion means two submissions for one session.
 */
async function lockSession(
  tx: Database,
  participantId: string,
  sessionId: string,
): Promise<SessionRow> {
  const result = await tx.execute(
    sql`SELECT * FROM research.participant_sessions
        WHERE id = ${sessionId} AND participant_id = ${participantId}
        FOR UPDATE`,
  );
  const rows = (result as unknown as { rows: Record<string, unknown>[] }).rows;
  const row = rows[0];
  if (!row) throw ApiErrors.sessionNotFound();

  return {
    id: row["id"] as string,
    participantId: row["participant_id"] as string,
    studyId: row["study_id"] as string,
    protocolVersionId: row["protocol_version_id"] as string,
    protocolStepId: row["protocol_step_id"] as string,
    occurrenceIndex: row["occurrence_index"] as number,
    questionnaireVersionId: row["questionnaire_version_id"] as string,
    status: row["status"] as string,
    triggerFiredAt: asDate(row["trigger_fired_at"]),
    scheduledAt: asDate(row["scheduled_at"]),
    availableFrom: asDate(row["available_from"]),
    availableUntil: asDate(row["available_until"]),
    startedAt: asDate(row["started_at"]),
    completedAt: asDate(row["completed_at"]),
    expiredAt: asDate(row["expired_at"]),
    cancelledAt: asDate(row["cancelled_at"]),
    cancellationReason: (row["cancellation_reason"] as string | null) ?? null,
    createdAt: asDate(row["created_at"]) ?? new Date(0),
    updatedAt: asDate(row["updated_at"]) ?? new Date(0),
  };
}

function asDate(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(String(value));
}

async function recordHistory(
  tx: Database,
  sessionId: string,
  answer: SaveAnswerRequest,
  outcome: string,
  now: Date,
): Promise<void> {
  await tx.insert(responseHistory).values({
    sessionId,
    questionVersionId: answer.questionVersionId,
    clientRevision: answer.clientRevision,
    outcome,
    submitted: {
      valueNumber: answer.valueNumber,
      valueText: answer.valueText,
      selectedOptionIds: answer.selectedOptionIds,
    },
    receivedAt: now,
    createdAt: now,
  });
}

/**
 * A fingerprint of exactly what was submitted.
 *
 * Sorted, so the hash depends on the answers and not on the order rows came
 * back. It is what lets a later question — "did a stored answer change after
 * completion?" — be settled without trusting the audit trail to be complete.
 */
function contentHash(
  stored: readonly (typeof responses.$inferSelect)[],
  selections: ReadonlyMap<string, string[]>,
): string {
  const canonical = stored
    .map((response) => ({
      q: response.questionVersionId,
      n: response.valueNumber,
      t: response.valueText,
      o: [...(selections.get(response.id) ?? [])].sort(),
    }))
    .sort((a, b) => a.q.localeCompare(b.q));

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function writeRefusal(
  reason: "NOT_YET_AVAILABLE" | "WINDOW_CLOSED" | "ALREADY_COMPLETED" | "CANCELLED" | "EXPIRED",
) {
  switch (reason) {
    case "NOT_YET_AVAILABLE":
      return ApiErrors.sessionNotAvailable();
    case "ALREADY_COMPLETED":
      return ApiErrors.sessionAlreadyCompleted();
    case "CANCELLED":
      return ApiErrors.sessionCancelled();
    case "WINDOW_CLOSED":
    case "EXPIRED":
    default:
      return ApiErrors.sessionWindowClosed();
  }
}
