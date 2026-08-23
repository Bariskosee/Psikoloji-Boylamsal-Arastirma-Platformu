import { z } from "zod";
import { sessionStatusSchema } from "./session.js";

/**
 * Monitoring and compliance vocabulary (PLAN.md Phase 10, FR-27, FR-28, FR-44).
 *
 * ── The shape that stops a number lying ─────────────────────────────────────
 * Every compliance figure here is `{ numerator, denominator, percent }` with
 * `percent` nullable, never a bare number. Three consequences, all deliberate:
 *
 *  - **The denominator is displayed, not hidden.** PLAN.md Phase 10 requires
 *    it, and `docs/compliance-formula.md` explains why: the denominator rule is
 *    the part most often left implicit and the part that changes the number
 *    most. "80%" over ten sessions and over two are different claims.
 *  - **`percent: null` means "not yet applicable"**, which is not `0`. Zero
 *    percent means "had opportunities and took none" — a materially different
 *    statement about a person (§5).
 *  - A client cannot render a figure without deciding what to do about the
 *    null, so the not-applicable case cannot be forgotten into a `0`.
 *
 * Nothing here re-implements a formula. Every value is produced by
 * `packages/domain/src/compliance`, which is the single implementation
 * `docs/compliance-formula.md` requires.
 */

export const complianceFigureSchema = z.object({
  numerator: z.number().int().min(0),
  denominator: z.number().int().min(0),
  /** 0–100, one decimal. Null when the denominator is zero (§5). */
  percent: z.number().min(0).max(100).nullable(),
});

export type ComplianceFigure = z.infer<typeof complianceFigureSchema>;

/**
 * How a step's figure should be READ, decided by the server (§6).
 *
 * `ADHERENCE` for a recurring block — "how many of the daily reports did they
 * file?" — and `COMPLETION` for a single measurement — "did they do it?". A
 * percentage is a poor rendering of a one-in-one measurement, so the kind
 * travels with the number and the interface cannot accidentally print "100%"
 * for an endline.
 */
export const STEP_COMPLIANCE_KINDS = ["ADHERENCE", "COMPLETION"] as const;
export const stepComplianceKindSchema = z.enum(STEP_COMPLIANCE_KINDS);

export const STEP_COMPLETION_STATES = [
  "COMPLETED",
  "MISSED",
  "NOT_YET_DUE",
  "OPEN",
  /** Cancelled — never offered. Reads as "not applicable", never as missed. */
  "EXCLUDED",
] as const;
export const stepCompletionStateSchema = z.enum(STEP_COMPLETION_STATES);

export const stepComplianceSchema = z.object({
  stepKey: z.string(),
  occurrenceCount: z.number().int().min(1),
  kind: stepComplianceKindSchema,
  compliance: complianceFigureSchema,
  /** Present for `COMPLETION` only. */
  state: stepCompletionStateSchema.nullable(),
  countsTowardCompliance: z.boolean(),
});

export type StepComplianceSummary = z.infer<typeof stepComplianceSchema>;

/**
 * The study overview (FR-27).
 *
 * `averageCompliancePercent` is null rather than zero when nobody has a
 * denominator yet, and `averageOverParticipants` is mandatory beside it —
 * §7 requires the participant count behind any average to be displayed,
 * because "68%" over three people and over three hundred are different claims.
 */
export const studyOverviewSchema = z.object({
  participants: z.object({
    total: z.number().int(),
    active: z.number().int(),
    withdrawn: z.number().int(),
    completed: z.number().int(),
  }),
  averageCompliancePercent: z.number().nullable(),
  averageOverParticipants: z.number().int(),
  /** Enrolled but with nothing due yet. Explains the gap in the count above. */
  notYetApplicableParticipants: z.number().int(),
  sessions: z.object({
    completed: z.number().int(),
    missed: z.number().int(),
    open: z.number().int(),
    notYetDue: z.number().int(),
    cancelled: z.number().int(),
  }),
});

export type StudyOverviewResponse = z.infer<typeof studyOverviewSchema>;

/**
 * One day's breakdown (§8, FR-28).
 *
 * Two groups whose parts each sum to their own total. §8 is explicit that the
 * categories overlap by construction — a session that expired unstarted is both
 * "not started" and "missed" — so four independent counts would appear to
 * double-count and a reader adding them up would get more sessions than exist.
 */
export const dailyComplianceSchema = z.object({
  /** ISO date in the STUDY's timezone, not the reader's. */
  date: z.string(),
  closed: z.number().int(),
  completed: z.number().int(),
  missedUnstarted: z.number().int(),
  missedPartial: z.number().int(),
  open: z.number().int(),
  notStarted: z.number().int(),
  inProgress: z.number().int(),
});

export type DailyCompliance = z.infer<typeof dailyComplianceSchema>;

export const dailyComplianceListSchema = z.object({
  timezone: z.string(),
  days: z.array(dailyComplianceSchema),
});

export type DailyComplianceResponse = z.infer<typeof dailyComplianceListSchema>;

/** One row of the participant list. Pseudonymous: a public code and nothing else. */
export const participantRowSchema = z.object({
  participantId: z.string().uuid(),
  publicCode: z.string(),
  status: z.enum(["ACTIVE", "COMPLETED", "WITHDRAWN"]),
  enrolledAt: z.string(),
  groupKey: z.string().nullable(),
  elapsed: complianceFigureSchema,
  strict: complianceFigureSchema,
  perStep: z.array(stepComplianceSchema),
});

export type ParticipantRow = z.infer<typeof participantRowSchema>;

export const participantListSchema = z.object({
  participants: z.array(participantRowSchema),
  /**
   * Cursor pagination, not offset. A dashboard paging through participants
   * while enrollment continues would otherwise show the same person twice and
   * skip another, because an offset shifts under inserts.
   */
  nextCursor: z.string().nullable(),
});

export type ParticipantListResponse = z.infer<typeof participantListSchema>;

/**
 * One session on a participant's timeline.
 *
 * Every session the protocol implies appears, including the ones no state has
 * been reached for yet and the ones cancelled by a late enrollment. A timeline
 * that omitted them would make a thirty-occurrence block look shorter than it
 * is, and would silently turn "never offered" into "absent".
 */
export const timelineEntrySchema = z.object({
  sessionId: z.string().uuid(),
  stepKey: z.string(),
  stepIndex: z.number().int(),
  occurrenceIndex: z.number().int(),
  status: sessionStatusSchema,
  /** Set only for CANCELLED; `ENROLLED_AFTER_WINDOW` reads as not applicable. */
  cancellationReason: z.string().nullable(),
  availableFrom: z.string().nullable(),
  availableUntil: z.string().nullable(),
  completedAt: z.string().nullable(),
  countsTowardCompliance: z.boolean(),
  /** How many answers exist. Distinguishes "opened" from "opened and typed". */
  responseCount: z.number().int(),
});

export type TimelineEntry = z.infer<typeof timelineEntrySchema>;

export const participantDetailSchema = z.object({
  participantId: z.string().uuid(),
  publicCode: z.string(),
  status: z.enum(["ACTIVE", "COMPLETED", "WITHDRAWN"]),
  enrolledAt: z.string(),
  withdrawnAt: z.string().nullable(),
  groupKey: z.string().nullable(),
  /** IANA zone, for reading the timeline in the participant's own day. */
  timezone: z.string().nullable(),
  locale: z.string(),
  elapsed: complianceFigureSchema,
  strict: complianceFigureSchema,
  perStep: z.array(stepComplianceSchema),
  timeline: z.array(timelineEntrySchema),
});

export type ParticipantDetailResponse = z.infer<typeof participantDetailSchema>;

/**
 * The seven missingness statuses (`docs/export-codebook.md` §2).
 *
 * The inspector must render all seven DISTINCTLY, and none of them as a zero.
 * `0` for an absent answer is the single most damaging thing this system could
 * emit — it is a real value in every statistical package, and no reader
 * downstream can tell it from a genuine zero (AGENT.md §17).
 */
export const RESPONSE_STATUSES = [
  "ANSWERED",
  "SKIPPED_OPTIONAL",
  "MISSED_ITEM_PARTIAL",
  "MISSED_SESSION",
  "IN_PROGRESS",
  "NOT_YET_DUE",
  "NOT_APPLICABLE",
] as const;
export const responseStatusSchema = z.enum(RESPONSE_STATUSES);
export type ResponseStatus = z.infer<typeof responseStatusSchema>;

export const inspectedAnswerSchema = z.object({
  questionKey: z.string(),
  questionText: z.string(),
  type: z.string(),
  status: responseStatusSchema,
  /**
   * Null for all six non-`ANSWERED` statuses. Not an empty string, not a zero,
   * not a sentinel — a nullable field is the only shape in which "absent"
   * cannot be mistaken for a value.
   */
  value: z.string().nullable(),
  answeredAt: z.string().nullable(),
});

export type InspectedAnswer = z.infer<typeof inspectedAnswerSchema>;

export const sessionInspectionSchema = z.object({
  sessionId: z.string().uuid(),
  publicCode: z.string(),
  stepKey: z.string(),
  occurrenceIndex: z.number().int(),
  status: sessionStatusSchema,
  questionnaireName: z.string(),
  answers: z.array(inspectedAnswerSchema),
});

export type SessionInspectionResponse = z.infer<typeof sessionInspectionSchema>;

/**
 * The operations page (admin only).
 *
 * Deliberately NOT served by the analytics role: sweeper heartbeats live in
 * `research` but push subscription attrition lives in `identity`, which the
 * analytics role cannot see — correctly. Operational health is a different
 * question from research analysis and uses a different connection.
 *
 * Nothing here identifies a participant. Counts and timestamps only.
 */
export const operationsHealthSchema = z.object({
  sweepers: z.array(
    z.object({
      workerId: z.string(),
      sweptAt: z.string(),
      /** Seconds since the last sweep. Beyond a few intervals means trouble. */
      ageSeconds: z.number().int(),
      sweepIntervalSeconds: z.number().int(),
      consecutiveFailures: z.number().int(),
      lastError: z.string().nullable(),
      stale: z.boolean(),
    }),
  ),
  deadLetteredJobs: z.array(
    z.object({
      queue: z.string(),
      count: z.number().int(),
      newestAt: z.string().nullable(),
    }),
  ),
  notifications: z.object({
    last24h: z.number().int(),
    accepted: z.number().int(),
    failed: z.number().int(),
    suppressed: z.number().int(),
    /** By reason, so a spike in one cause is visible rather than averaged away. */
    suppressionReasons: z.record(z.string(), z.number().int()),
  }),
  pushSubscriptions: z.object({
    active: z.number().int(),
    inactive: z.number().int(),
    /** Deactivated in the last 7 days — the attrition signal. */
    recentlyLost: z.number().int(),
  }),
});

export type OperationsHealthResponse = z.infer<typeof operationsHealthSchema>;

/**
 * Descriptive distributions (PLAN.md Phase 11).
 *
 * ── Derived from the researcher's own configuration ─────────────────────────
 * PLAN.md is explicit: **never assume a demographic variable exists**. There is
 * no "age", no "gender", no "group" field anywhere in these shapes. What a
 * study measures is whatever its questionnaires ask, so a distribution is
 * always keyed by `question_key` and its categories are always the options the
 * researcher defined (AGENT.md §3.4).
 *
 * ── Why `missing` is a first-class count ────────────────────────────────────
 * A bar chart that silently omits non-responses shows a cleaner study than the
 * one that was run. The count of cells that were NOT answered travels with
 * every distribution so a reader can see the denominator the percentages are
 * over, and so no chart can imply completeness it does not have.
 */
export const optionDistributionSchema = z.object({
  questionKey: z.string(),
  questionText: z.string(),
  type: z.string(),
  stepKey: z.string(),
  /** Answered cells only; `missing` is reported separately, never as a bar. */
  answered: z.number().int(),
  missing: z.number().int(),
  categories: z.array(
    z.object({
      optionKey: z.string(),
      label: z.string(),
      /** The numeric code, where the option carries one (Likert anchors). */
      value: z.number().nullable(),
      count: z.number().int(),
      /** Of ANSWERED cells, not of all cells. Null when nothing was answered. */
      percent: z.number().nullable(),
    }),
  ),
});

export type OptionDistribution = z.infer<typeof optionDistributionSchema>;

export const numericDistributionSchema = z.object({
  questionKey: z.string(),
  questionText: z.string(),
  stepKey: z.string(),
  answered: z.number().int(),
  missing: z.number().int(),
  /** Null throughout when nothing was answered — never 0, which is a value. */
  min: z.number().nullable(),
  max: z.number().nullable(),
  mean: z.number().nullable(),
  median: z.number().nullable(),
});

export type NumericDistribution = z.infer<typeof numericDistributionSchema>;

/** Completions per day, in the study's timezone. */
export const completionPointSchema = z.object({
  date: z.string(),
  completed: z.number().int(),
});

export const distributionsSchema = z.object({
  timezone: z.string(),
  options: z.array(optionDistributionSchema),
  numerics: z.array(numericDistributionSchema),
  completionOverTime: z.array(completionPointSchema),
});

export type DistributionsResponse = z.infer<typeof distributionsSchema>;
