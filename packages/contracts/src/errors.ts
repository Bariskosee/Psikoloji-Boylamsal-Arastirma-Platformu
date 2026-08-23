import { z } from "zod";

/**
 * Stable, machine-readable error codes.
 *
 * STRUCTURE.md §12 requires codes rather than raw messages: a client must be
 * able to branch on `SESSION_EXPIRED` without string-matching prose that a
 * translator will change next week. Codes are also what the participant app
 * localises against, so they are part of the contract, not an implementation
 * detail of the API.
 *
 * Phase 2 defines the authentication, authorization, and study codes. Later
 * phases append; existing codes are never renamed once a client depends on one.
 */
export const API_ERROR_CODES = [
  // Generic
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMITED",
  "INTERNAL_ERROR",

  // Authentication (Phase 2)
  "INVALID_CREDENTIALS",
  "AUTHENTICATION_REQUIRED",
  "SESSION_EXPIRED",
  "ACCOUNT_DISABLED",
  // One code for every way a reset link can fail. Distinguishing them would
  // tell somebody holding a stolen link that it was real (Phase 12).
  "INVALID_RESET_TOKEN",
  "PASSWORD_TOO_WEAK",
  "CSRF_FAILED",

  // Authorization (Phase 2)
  "FORBIDDEN",
  "STUDY_ROLE_REQUIRED",

  // Study (Phase 2)
  "STUDY_NOT_FOUND",
  "INVALID_STUDY_TRANSITION",
  "ENROLLMENT_CODE_UNAVAILABLE",
  "LAST_OWNER_REQUIRED",

  // Questionnaire (Phase 3)
  "QUESTIONNAIRE_NOT_FOUND",
  "QUESTION_NOT_FOUND",
  "QUESTION_OPTION_NOT_FOUND",
  "INVALID_REORDER",
  "QUESTION_TYPE_HAS_NO_OPTIONS",

  /**
   * Publish refusals. Each blocking condition gets its OWN code rather than a
   * shared `CONFLICT`, because publishing is irreversible and the researcher
   * has to be told exactly what to fix — and told it in their own language.
   * A frontend that has only `CONFLICT` to branch on ends up rendering the
   * server's English `message`, which this file's contract forbids.
   *
   * The two that name a specific question carry its 1-based position in
   * `details`, so the interface can point at it without parsing English.
   */
  "QUESTIONNAIRE_EMPTY",
  "QUESTION_OPTIONS_REQUIRED",
  "QUESTION_SELECTION_BOUNDS_UNSATISFIABLE",

  // Protocol (Phase 4)
  "PROTOCOL_NOT_FOUND",
  "PROTOCOL_STEP_NOT_FOUND",
  "QUESTIONNAIRE_VERSION_NOT_PUBLISHED",

  /**
   * Protocol publish refusals, one code per blocking condition for the same
   * reason as the questionnaire ones above. Each carries the offending
   * `step_key` in `details`, so the builder can point at the step without
   * parsing English.
   *
   * `PROTOCOL_STEP_COMPLETION_OF_RECURRING` is FR-48c, the rule that stops a
   * missed daily report from destroying a study's outcome measurement thirty
   * days later.
   */
  "PROTOCOL_EMPTY",
  "PROTOCOL_TRIGGER_DANGLING",
  "PROTOCOL_TRIGGER_CYCLE",
  "PROTOCOL_TRIGGER_NEEDS_OCCURRENCE",
  "PROTOCOL_TRIGGER_OCCURRENCE_OUT_OF_RANGE",
  "PROTOCOL_STEP_COMPLETION_OF_RECURRING",
  "PROTOCOL_DUPLICATE_STEP_KEY",

  // Consent and participants (Phase 5)
  "CONSENT_VERSION_NOT_FOUND",
  "CONSENT_VERSION_EMPTY",
  /** The consent text the participant read is no longer the study's current one. */
  "CONSENT_VERSION_STALE",
  "STUDY_NOT_ACCEPTING_ENROLLMENTS",
  "PARTICIPANT_NOT_FOUND",
  "PARTICIPANT_CODE_UNAVAILABLE",
  /**
   * The continuity cookie is absent, unknown, revoked, or past its grace
   * period. Deliberately ONE code for all four: distinguishing them would tell
   * a caller whether a token they hold ever existed.
   */
  "PARTICIPANT_AUTH_REQUIRED",
  "PARTICIPANT_WITHDRAWN",

  // Questionnaire runtime (Phase 6)
  "SESSION_NOT_FOUND",
  /** The window has not opened yet. */
  "SESSION_NOT_AVAILABLE",
  /** The window has closed. Decided on the SERVER clock, always. */
  "SESSION_WINDOW_CLOSED",
  "SESSION_ALREADY_COMPLETED",
  "SESSION_CANCELLED",
  /** The submitted value is not legal for the question version shown. */
  "ANSWER_REJECTED",
  /** Carries the `question_key` of each unanswered required question. */
  "REQUIRED_QUESTIONS_UNANSWERED",

  // Push and the install handoff (Phase 8)
  /**
   * This deployment has no VAPID key pair, so no study running on it can send
   * a push. Its own code rather than a generic conflict because the client's
   * response is specific: stop offering to enable notifications, and say that
   * the study is running without them (ADR-006).
   */
  "PUSH_NOT_CONFIGURED",
  "PUSH_SUBSCRIPTION_NOT_FOUND",
  /**
   * The install handoff link is expired, already redeemed, or was never ours.
   * Deliberately ONE code for all three, for the same reason as
   * `PARTICIPANT_AUTH_REQUIRED`: distinguishing them would confirm to a caller
   * that a code they hold once existed.
   */
  "HANDOFF_CODE_INVALID",

  // Notifications (Phase 9)
  /**
   * The client reported an event for an attempt this participant has no record
   * of. One code for "no such attempt" and "not yours", for the same
   * enumeration reason as everywhere else: a caller must not be able to learn
   * that some other participant was notified about some session.
   */
  "NOTIFICATION_ATTEMPT_NOT_FOUND",
] as const;

export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

/**
 * Every non-2xx response body has this shape.
 *
 * `message` is developer-facing English for logs and debugging. It is NOT the
 * string shown to a user — both frontends translate `code` through their own
 * catalogues, so an English message never leaks into a Turkish interface.
 */
export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    /** Field-level detail, present only for VALIDATION_FAILED. */
    details: z
      .array(
        z.object({
          path: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
