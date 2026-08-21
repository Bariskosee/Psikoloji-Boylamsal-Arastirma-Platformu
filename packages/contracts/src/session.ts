import { z } from "zod";
import { localeSchema } from "./locale.js";
import { questionTypeSchema } from "./question-types.js";

/**
 * The questionnaire runtime (PLAN.md Phase 6).
 *
 * What a participant is given to answer, what they send back, and what a
 * completion produces. The session's window is present but advisory: every
 * decision about whether a write is allowed is taken on the SERVER's clock, and
 * these timestamps are here so the interface can explain itself, not so the
 * client can decide.
 */

export const SESSION_STATUSES = [
  "PENDING_TRIGGER",
  "SCHEDULED",
  "AVAILABLE",
  "STARTED",
  "COMPLETED",
  "EXPIRED_UNSTARTED",
  "EXPIRED_PARTIAL",
  "CANCELLED",
] as const;

export const sessionStatusSchema = z.enum(SESSION_STATUSES);
export type SessionStatusValue = z.infer<typeof sessionStatusSchema>;

/** One option as the participant sees it. */
export const runtimeOptionSchema = z.object({
  id: z.string().uuid(),
  optionKey: z.string(),
  label: z.string(),
  isExclusive: z.boolean(),
});

/**
 * One question, already resolved into the participant's language.
 *
 * The server picks the translation rather than sending every locale: the
 * participant chose a language at enrollment, and shipping the others would
 * put text they never see into a payload sent over a phone connection.
 */
export const runtimeQuestionSchema = z.object({
  id: z.string().uuid(),
  questionKey: z.string(),
  type: questionTypeSchema,
  isRequired: z.boolean(),
  pageIndex: z.number().int().min(0),
  displayOrder: z.number().int().min(0),
  text: z.string(),
  config: z.record(z.string(), z.unknown()),
  options: z.array(runtimeOptionSchema),
});

export type RuntimeQuestion = z.infer<typeof runtimeQuestionSchema>;

/** A saved answer, as the client should restore it. */
export const savedAnswerSchema = z.object({
  questionVersionId: z.string().uuid(),
  valueNumber: z.number().nullable(),
  valueText: z.string().nullable(),
  selectedOptionIds: z.array(z.string().uuid()),
  clientRevision: z.number().int(),
  answeredAt: z.string(),
});

export type SavedAnswer = z.infer<typeof savedAnswerSchema>;

export const sessionDetailSchema = z.object({
  id: z.string().uuid(),
  status: sessionStatusSchema,
  stepKey: z.string(),
  occurrenceIndex: z.number().int(),
  locale: localeSchema,
  availableFrom: z.string().nullable(),
  availableUntil: z.string().nullable(),
  /**
   * The server's clock at the moment it answered.
   *
   * Sent so the interface can show a truthful countdown without trusting the
   * device clock — which may be wrong by hours and is the one input that must
   * never decide whether a window is open.
   */
  serverTime: z.string(),
  questions: z.array(runtimeQuestionSchema),
  answers: z.array(savedAnswerSchema),
  pageCount: z.number().int(),
});

export type SessionDetail = z.infer<typeof sessionDetailSchema>;

export const sessionSummarySchema = z.object({
  id: z.string().uuid(),
  status: sessionStatusSchema,
  stepKey: z.string(),
  occurrenceIndex: z.number().int(),
  availableFrom: z.string().nullable(),
  availableUntil: z.string().nullable(),
  questionnaireName: z.string(),
});

export type SessionSummary = z.infer<typeof sessionSummarySchema>;

export const sessionListSchema = z.object({ sessions: z.array(sessionSummarySchema) });
export type SessionListResponse = z.infer<typeof sessionListSchema>;

/**
 * One autosave.
 *
 * `clientRevision` is a per-question monotonic counter the client owns. The
 * server keeps the highest it has seen and ignores anything at or below it, so
 * a retry is a no-op and a replayed outbox entry cannot overwrite a later
 * correction.
 */
export const saveAnswerSchema = z
  .object({
    questionVersionId: z.string().uuid(),
    clientRevision: z.number().int().min(0),
    valueNumber: z.number().finite().nullable().default(null),
    valueText: z.string().max(10_000).nullable().default(null),
    selectedOptionIds: z.array(z.string().uuid()).max(1000).default([]),
  })
  .strict();

export type SaveAnswerRequest = z.infer<typeof saveAnswerSchema>;

/** A batch, which is what an outbox replays after a reconnection. */
export const saveAnswersSchema = z.object({
  answers: z.array(saveAnswerSchema).min(1).max(200),
});

export type SaveAnswersRequest = z.infer<typeof saveAnswersSchema>;

export const ANSWER_OUTCOMES = ["APPLY", "IGNORE_STALE", "IGNORE_DUPLICATE"] as const;
export const answerOutcomeSchema = z.enum(ANSWER_OUTCOMES);
export type AnswerOutcome = z.infer<typeof answerOutcomeSchema>;

/**
 * What happened to each answer in the batch.
 *
 * Reported per answer rather than as one status for the request, because a
 * replayed outbox routinely contains a mixture: some entries are new, some the
 * server already has. Failing the batch on the duplicates would make the outbox
 * unable to drain.
 */
export const saveAnswersResponseSchema = z.object({
  results: z.array(
    z.object({
      questionVersionId: z.string().uuid(),
      outcome: answerOutcomeSchema,
      /** The revision the server now holds, so a client can resynchronise. */
      storedRevision: z.number().int(),
    }),
  ),
  status: sessionStatusSchema,
  serverTime: z.string(),
});

export type SaveAnswersResponse = z.infer<typeof saveAnswersResponseSchema>;

export const completeSessionResponseSchema = z.object({
  sessionId: z.string().uuid(),
  completedAt: z.string(),
  answeredCount: z.number().int(),
  requiredCount: z.number().int(),
  /** True when this call found the session already complete. */
  alreadyCompleted: z.boolean(),
});

export type CompleteSessionResponse = z.infer<typeof completeSessionResponseSchema>;
