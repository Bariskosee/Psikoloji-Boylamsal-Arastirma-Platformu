import { z } from "zod";

/**
 * Protocol vocabulary (STRUCTURE.md §8, PLAN.md Phase 4).
 *
 * A protocol is the study's schedule expressed as data: which questionnaire is
 * administered, when it opens, how long it stays open, how often it repeats,
 * and how the participant is reminded. Nothing here executes — Phase 4 writes
 * these rows and stops. The engine that materialises sessions from them is
 * Phase 7.
 *
 * Every value a researcher configures lives in these shapes. None of the
 * reference design's numbers — 30 occurrences, `P1D`, `20:00`, `PT12H` —
 * appears as a default or a constant anywhere (AGENT.md §3.4, §17, and
 * `docs/reference-protocol.md` §9).
 */

/**
 * How a step's origin instant is found.
 *
 * `ENROLLMENT` / `CONSENT`   — an instant on the participant's own record.
 * `FIXED_DATETIME`           — a cohort-wide calendar instant set by the
 *                              researcher, the same for every participant.
 * `STEP_COMPLETED`           — when the participant finished another step.
 * `STEP_AVAILABLE`           — when another step's window OPENED, which the
 *                              server computes and the participant cannot
 *                              affect.
 *
 * The last two are the only ones that reference another step, and the
 * difference between them is the whole of FR-48c: availability is a fact about
 * the schedule, completion is a fact about the participant.
 */
export const TRIGGER_TYPES = [
  "ENROLLMENT",
  "CONSENT",
  "STEP_COMPLETED",
  "STEP_AVAILABLE",
  "FIXED_DATETIME",
] as const;

export const triggerTypeSchema = z.enum(TRIGGER_TYPES);
export type TriggerType = z.infer<typeof triggerTypeSchema>;

/** The two trigger types whose reference to another step must be resolved. */
export const STEP_REFERENCING_TRIGGERS = ["STEP_COMPLETED", "STEP_AVAILABLE"] as const;

export function isStepReferencingTrigger(trigger: TriggerType): boolean {
  return (STEP_REFERENCING_TRIGGERS as readonly TriggerType[]).includes(trigger);
}

/**
 * Whose clock a wall-clock anchor reads.
 *
 * `PARTICIPANT` means "18:00 wherever they are", `STUDY` means "18:00 in the
 * study's zone, whatever that is for them". Both are legitimate and they
 * differ for any participant who travels or was recruited elsewhere, so the
 * choice is explicit rather than inferred.
 */
export const ANCHOR_TIMEZONE_SOURCES = ["STUDY", "PARTICIPANT"] as const;
export const anchorTimezoneSourceSchema = z.enum(ANCHOR_TIMEZONE_SOURCES);
export type AnchorTimezoneSource = z.infer<typeof anchorTimezoneSourceSchema>;

/**
 * `SCHEDULED` steps are materialised at enrollment; `PARTICIPANT_INITIATED`
 * ones have no computable time and are created on demand (FR-46,
 * STRUCTURE.md §8.2). Phase 4 stores the distinction; nothing acts on it yet.
 */
export const STEP_KINDS = ["SCHEDULED", "PARTICIPANT_INITIATED"] as const;
export const stepKindSchema = z.enum(STEP_KINDS);
export type StepKind = z.infer<typeof stepKindSchema>;

/** What a reminder does when it falls inside quiet hours (FR-40). */
export const QUIET_HOURS_BEHAVIORS = ["SKIP", "DEFER"] as const;
export const quietHoursBehaviorSchema = z.enum(QUIET_HOURS_BEHAVIORS);
export type QuietHoursBehavior = z.infer<typeof quietHoursBehaviorSchema>;

/** Mirrors questionnaire versions: one draft, then immutable published rows. */
export const PROTOCOL_VERSION_STATUSES = ["DRAFT", "PUBLISHED", "RETIRED"] as const;
export const protocolVersionStatusSchema = z.enum(PROTOCOL_VERSION_STATUSES);
export type ProtocolVersionStatus = z.infer<typeof protocolVersionStatusSchema>;

/**
 * An ISO-8601 duration, restricted to the forms this platform computes with.
 *
 * Weeks (`P4W`), months, and years are deliberately rejected. A month is not a
 * fixed length, so `P1M` would make "when does this open?" depend on which
 * month the participant enrolled in — a difference of up to three days in a
 * schedule researchers read as regular. Days, hours, minutes, and seconds are
 * exact, and a researcher who wants four weeks writes `P28D`.
 *
 * The zero duration `PT0S` is valid and common: it is what "at enrollment,
 * immediately" looks like.
 */
export const ISO_DURATION_PATTERN = /^P(?!$)(\d+D)?(T(?!$)(\d+H)?(\d+M)?(\d+S)?)?$/;

export const isoDurationSchema = z
  .string()
  .regex(
    ISO_DURATION_PATTERN,
    "Must be an ISO-8601 duration using days, hours, minutes or seconds — for example P1D, PT12H, PT0S",
  );

/**
 * A local wall-clock time, `HH:MM` on a 24-hour clock.
 *
 * No seconds: a schedule accurate to the second is a false promise, since
 * delivery depends on a sweep interval and on the participant's device being
 * reachable.
 */
export const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const localTimeSchema = z
  .string()
  .regex(LOCAL_TIME_PATTERN, "Must be a 24-hour local time, for example 20:00");

/**
 * The stable export column prefix for a step (`docs/export-codebook.md`).
 *
 * Wide-format columns are `{step_key}_{occurrence_index}__{question_key}`, so
 * a `__` inside a step key would make the column name ambiguous to any script
 * splitting on it. Single underscores are fine — `my_step_0__q_abc` still
 * parses, because the separator is the doubled one.
 *
 * Researcher-authored rather than generated, unlike `question_key`: it appears
 * in the analyst's CSV headers, where `baseline` is worth far more than
 * `s_4kf92hd1qp`.
 */
export const stepKeySchema = z
  .string()
  .min(1)
  .max(40)
  .regex(
    /^[a-z][a-z0-9_]*$/,
    "Use lowercase letters, digits and underscores, starting with a letter",
  )
  .refine((value) => !value.includes("__"), {
    message: "Must not contain a double underscore — that is the export column separator",
  });

/**
 * The floor on reminder cadence.
 *
 * A typo in an interval — `PT5M` where `PT5H` was meant — becomes a
 * notification storm aimed at every enrolled participant, which is both a
 * research-ethics problem and the fastest way to lose a push subscription to
 * the participant disabling notifications. PLAN.md Phase 4 requires the floor;
 * this is the value it is measured against, and it is platform policy rather
 * than study configuration.
 */
export const MINIMUM_REMINDER_INTERVAL_MINUTES = 15;

/**
 * Seconds in an `ISO_DURATION_PATTERN` duration.
 *
 * Exact by construction: the pattern admits only days, hours, minutes, and
 * seconds, every one of which is a fixed number of seconds. This is why weeks
 * and months are excluded from the pattern — with them, this function would
 * have to guess a calendar position to answer.
 *
 * @lpr/domain does its arithmetic with Luxon; this exists so that a schema in
 * the dependency leaf can compare two durations without taking a dependency.
 */
export function isoDurationSeconds(duration: string): number {
  const match = ISO_DURATION_PATTERN.exec(duration);
  if (!match) return Number.NaN;

  const amount = (group: string | undefined): number =>
    group === undefined ? 0 : Number.parseInt(group, 10);

  return (
    amount(match[1]) * 86_400 + amount(match[3]) * 3_600 + amount(match[4]) * 60 + amount(match[5])
  );
}

const reminderPolicyFields = z.object({
  /** How long after the window opens the first reminder may go out. */
  initialDelayIso: isoDurationSchema,
  /** Spacing between reminders after the first. */
  intervalIso: isoDurationSchema,
  /**
   * Required, with no default. FR-40 makes the cap mandatory precisely so that
   * "how many times will this participant be contacted?" always has an answer
   * a researcher chose, rather than one that emerged from the cadence and the
   * window length.
   */
  maxReminders: z.number().int().min(0).max(20),
  /** Both or neither: a start without an end does not describe an interval. */
  quietHoursStart: localTimeSchema.nullable(),
  quietHoursEnd: localTimeSchema.nullable(),
  quietHoursBehavior: quietHoursBehaviorSchema,
});

/**
 * The cadence floor and the quiet-hours pairing are refinements rather than
 * field rules because each needs two fields at once.
 */
const refineReminderPolicy = <T extends z.ZodTypeAny>(schema: T) =>
  schema.superRefine((policy: z.infer<typeof reminderPolicyFields>, ctx: z.RefinementCtx) => {
    // Only checked when more than one reminder can be sent: with a cap of 0 or
    // 1 the interval never elapses, so a small value cannot produce a storm.
    if (
      policy.maxReminders > 1 &&
      isoDurationSeconds(policy.intervalIso) < MINIMUM_REMINDER_INTERVAL_MINUTES * 60
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intervalIso"],
        message: `Reminders must be at least ${String(MINIMUM_REMINDER_INTERVAL_MINUTES)} minutes apart`,
      });
    }

    if ((policy.quietHoursStart === null) !== (policy.quietHoursEnd === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["quietHoursEnd"],
        message: "Quiet hours need both a start and an end",
      });
    }
  });

export const reminderPolicySchema = refineReminderPolicy(reminderPolicyFields);

export type ReminderPolicyInput = z.infer<typeof reminderPolicyFields>;

export const reminderPolicyResponseSchema = refineReminderPolicy(
  reminderPolicyFields.extend({ id: z.string().uuid() }),
);

export type ReminderPolicyResponse = z.infer<typeof reminderPolicyResponseSchema>;

/**
 * A calendar date, `YYYY-MM-DD`, with no time and no zone.
 *
 * This is the anchor for a `FIXED_DATETIME` step: the designated start day of
 * a cohort. The instant it denotes is only fixed once combined with the step's
 * wall-clock anchor and the zone that anchor names, which is what makes
 * "everyone starts on the 7th at 20:00 their time" expressible.
 *
 * Storing a date rather than a timestamp is deliberate. A researcher picks a
 * day on a calendar; a timestamp would force the builder to guess a time and a
 * zone at the moment of picking, and the guess would be invisible afterwards.
 */
export const CALENDAR_DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

export const calendarDateSchema = z
  .string()
  .regex(CALENDAR_DATE_PATTERN, "Must be a calendar date, for example 2026-09-07");

/**
 * One step of a protocol.
 *
 * The cross-field rules below are the ones answerable from a single step. The
 * ones that need the whole graph — dangling references, cycles, and the FR-48
 * rules about recurring targets — live in @lpr/domain and run at publish,
 * because they cannot be decided while a draft is still half-built.
 */
export const protocolStepInputSchema = z
  .object({
    stepKey: stepKeySchema,
    questionnaireVersionId: z.string().uuid(),
    stepKind: stepKindSchema.default("SCHEDULED"),

    triggerType: triggerTypeSchema,
    /** Set for STEP_COMPLETED and STEP_AVAILABLE; null otherwise. */
    triggerStepId: z.string().uuid().nullable().default(null),
    /** Which occurrence of a recurring target is meant (FR-48a). */
    triggerOccurrenceIndex: z.number().int().min(0).nullable().default(null),
    /** The designated day for a FIXED_DATETIME step. */
    triggerFixedDate: calendarDateSchema.nullable().default(null),

    /** Duration-mode displacement from the origin. DST-immune. */
    offsetIso: isoDurationSchema.default("PT0S"),
    /** Wall-clock mode. Both fields travel together or neither is set. */
    anchorLocalTime: localTimeSchema.nullable().default(null),
    anchorTimezoneSource: anchorTimezoneSourceSchema.nullable().default(null),

    windowDurationIso: isoDurationSchema,

    occurrenceCount: z.number().int().min(1).max(1000).default(1),
    recurrenceIntervalIso: isoDurationSchema.nullable().default(null),

    countsTowardCompliance: z.boolean().default(true),

    /** Participant-initiated steps only. */
    minIntervalIso: isoDurationSchema.nullable().default(null),
    maxPerDay: z.number().int().min(1).nullable().default(null),
    maxTotal: z.number().int().min(1).nullable().default(null),

    /** Empty means every group (FR-45). */
    allowedGroupIds: z.array(z.string().uuid()).default([]),

    reminderPolicy: reminderPolicySchema.nullable().default(null),
  })
  .superRefine((step, ctx) => {
    const referencesStep = isStepReferencingTrigger(step.triggerType);

    if (referencesStep && step.triggerStepId === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggerStepId"],
        message: `A ${step.triggerType} trigger must name the step it follows`,
      });
    }
    if (!referencesStep && step.triggerStepId !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggerStepId"],
        message: `A ${step.triggerType} trigger does not follow another step`,
      });
    }
    // Whether an index is REQUIRED depends on the target's occurrence count,
    // which only the graph knows. What is decidable here is that an index
    // without a referenced step is meaningless.
    if (!referencesStep && step.triggerOccurrenceIndex !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggerOccurrenceIndex"],
        message: "An occurrence index only applies to a trigger that names another step",
      });
    }

    if (step.triggerType === "FIXED_DATETIME" && step.triggerFixedDate === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggerFixedDate"],
        message: "A fixed-datetime trigger needs the designated date",
      });
    }
    if (step.triggerType !== "FIXED_DATETIME" && step.triggerFixedDate !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["triggerFixedDate"],
        message: "Only a fixed-datetime trigger carries a designated date",
      });
    }

    // A local time with no zone to read it in is not an instant.
    if ((step.anchorLocalTime === null) !== (step.anchorTimezoneSource === null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["anchorTimezoneSource"],
        message: "A wall-clock anchor needs both a local time and the zone to read it in",
      });
    }

    // Recurrence without an interval has no way to place occurrence 1.
    if (step.occurrenceCount > 1 && step.recurrenceIntervalIso === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recurrenceIntervalIso"],
        message: "A step that repeats needs the interval between occurrences",
      });
    }
    if (step.occurrenceCount === 1 && step.recurrenceIntervalIso !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recurrenceIntervalIso"],
        message: "A step that happens once has no recurrence interval",
      });
    }

    const rateLimits = [step.minIntervalIso, step.maxPerDay, step.maxTotal];
    if (step.stepKind !== "PARTICIPANT_INITIATED" && rateLimits.some((v) => v !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stepKind"],
        message: "Rate limits apply only to a participant-initiated step",
      });
    }
  });

export type ProtocolStepInput = z.infer<typeof protocolStepInputSchema>;

/**
 * Updating a step.
 *
 * Every field is optional, but the cross-field rules still have to hold once
 * the patch is applied — which the service checks by re-validating the merged
 * row, not by trying to express "valid after merge" in a schema.
 */
export const updateProtocolStepSchema = protocolStepInputSchema.innerType().partial().strict();

export type UpdateProtocolStepRequest = z.infer<typeof updateProtocolStepSchema>;

export const createProtocolSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(""),
});

export type CreateProtocolRequest = z.infer<typeof createProtocolSchema>;

export const updateProtocolSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
});

export type UpdateProtocolRequest = z.infer<typeof updateProtocolSchema>;

export const reorderProtocolStepsSchema = z.object({
  /** Every step of the draft, in the order they should take. */
  stepIds: z.array(z.string().uuid()).min(1),
});

export type ReorderProtocolStepsRequest = z.infer<typeof reorderProtocolStepsSchema>;

export const protocolStepResponseSchema = protocolStepInputSchema.innerType().extend({
  id: z.string().uuid(),
  stepIndex: z.number().int().min(0),
  reminderPolicy: reminderPolicyResponseSchema.nullable(),
});

export type ProtocolStepResponse = z.infer<typeof protocolStepResponseSchema>;

export const protocolVersionSummarySchema = z.object({
  id: z.string().uuid(),
  status: protocolVersionStatusSchema,
  versionNumber: z.number().int().nullable(),
  stepCount: z.number().int(),
  publishedAt: z.string().nullable(),
});

export type ProtocolVersionSummary = z.infer<typeof protocolVersionSummarySchema>;

export const protocolVersionDetailSchema = protocolVersionSummarySchema.extend({
  protocolId: z.string().uuid(),
  steps: z.array(protocolStepResponseSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProtocolVersionDetail = z.infer<typeof protocolVersionDetailSchema>;

export const protocolDetailSchema = z.object({
  id: z.string().uuid(),
  studyId: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  draft: protocolVersionDetailSchema,
  publishedVersions: z.array(protocolVersionSummarySchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ProtocolDetail = z.infer<typeof protocolDetailSchema>;

export const protocolSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  draft: z.object({ id: z.string().uuid(), stepCount: z.number().int() }),
  latestPublished: protocolVersionSummarySchema.nullable(),
});

export type ProtocolSummary = z.infer<typeof protocolSummarySchema>;

export const protocolListResponseSchema = z.object({
  protocols: z.array(protocolSummarySchema),
});

export type ProtocolListResponse = z.infer<typeof protocolListResponseSchema>;

/**
 * The timeline preview (PLAN.md Phase 4).
 *
 * The researcher's only defence against misconfiguring a study, so it runs the
 * SAME domain functions the engine will in Phase 7 rather than a second
 * implementation that could agree with the builder and disagree with reality.
 *
 * A hypothetical participant is supplied rather than assumed: "what does this
 * look like for someone who enrols on the 4th, in Istanbul?" is the question
 * being asked, and every part of the answer depends on both.
 */
export const previewProtocolSchema = z.object({
  /** When the hypothetical participant enrolls. */
  enrolledAt: z.string().datetime(),
  /** Their zone; null means they never reported one and the study's is used. */
  participantTimezone: z.string().nullable().default(null),
  /**
   * When they complete each step, keyed by `step_key`. Supplying none is the
   * worst case worth previewing: a participant who completes nothing, which is
   * exactly the case FR-48c exists to protect.
   */
  completions: z.record(z.string(), z.string().datetime()).default({}),
});

export type PreviewProtocolRequest = z.infer<typeof previewProtocolSchema>;

export const previewOccurrenceSchema = z.object({
  occurrenceIndex: z.number().int(),
  availableFrom: z.string(),
  availableUntil: z.string(),
  adjustment: z.enum(["NONE", "SPRING_FORWARD_GAP", "FALL_BACK_AMBIGUOUS"]),
});

export const previewStepSchema = z.object({
  stepId: z.string().uuid(),
  stepKey: z.string(),
  questionnaireVersionId: z.string().uuid(),
  dependency: z.enum(["UNCONDITIONAL", "CONDITIONAL"]),
  dependsOnCompletionOf: z.array(z.string()),
  /**
   * Absent when the step's origin could not be resolved for this hypothetical
   * participant — which is what a conditional step whose prerequisite was never
   * completed looks like, and is the point of showing it.
   */
  occurrences: z.array(previewOccurrenceSchema).nullable(),
  unresolvedReason: z.string().nullable(),
});

export type PreviewStep = z.infer<typeof previewStepSchema>;

export const protocolPreviewResponseSchema = z.object({
  steps: z.array(previewStepSchema),
  /** Total sessions this participant would be given. */
  totalOccurrences: z.number().int(),
});

export type ProtocolPreviewResponse = z.infer<typeof protocolPreviewResponseSchema>;
