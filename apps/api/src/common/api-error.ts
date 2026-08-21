import { HttpException, HttpStatus } from "@nestjs/common";
import type { ApiErrorCode } from "@lpr/contracts";

/**
 * An error the client is allowed to see.
 *
 * Every failure crossing the HTTP boundary carries a stable
 * `ApiErrorCode` (STRUCTURE.md §12). The client branches on the code; the
 * message is developer-facing English for logs, never the string shown to a
 * participant or a researcher — both frontends translate the code themselves,
 * so an English sentence cannot leak into a Turkish interface.
 */
export class ApiException extends HttpException {
  constructor(
    readonly code: ApiErrorCode,
    status: HttpStatus,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super({ code, message, details }, status);
  }
}

export const ApiErrors = {
  validationFailed: (details: Array<{ path: string; message: string }>) =>
    new ApiException(
      "VALIDATION_FAILED",
      HttpStatus.BAD_REQUEST,
      "Request validation failed",
      details,
    ),

  /**
   * Deliberately uniform (STRUCTURE.md §11.5). Distinguishing "no such
   * account" from "wrong password" hands an attacker a free account
   * enumeration oracle, so both paths produce exactly this error — and the
   * auth service equalises the timing as well, because a fast "no such user"
   * next to a slow argon2id verification is the same oracle with extra steps.
   */
  invalidCredentials: () =>
    new ApiException("INVALID_CREDENTIALS", HttpStatus.UNAUTHORIZED, "Invalid email or password"),

  authenticationRequired: () =>
    new ApiException("AUTHENTICATION_REQUIRED", HttpStatus.UNAUTHORIZED, "Authentication required"),

  sessionExpired: () =>
    new ApiException("SESSION_EXPIRED", HttpStatus.UNAUTHORIZED, "Session expired"),

  accountDisabled: () =>
    new ApiException("ACCOUNT_DISABLED", HttpStatus.FORBIDDEN, "Account is disabled"),

  passwordTooWeak: (reasons: string[]) =>
    new ApiException(
      "PASSWORD_TOO_WEAK",
      HttpStatus.BAD_REQUEST,
      "Password does not meet the policy",
      reasons.map((reason) => ({ path: "newPassword", message: reason })),
    ),

  csrfFailed: (reason: string) =>
    new ApiException("CSRF_FAILED", HttpStatus.FORBIDDEN, `CSRF check failed: ${reason}`),

  forbidden: (message = "Forbidden") =>
    new ApiException("FORBIDDEN", HttpStatus.FORBIDDEN, message),

  studyRoleRequired: (required: string) =>
    new ApiException(
      "STUDY_ROLE_REQUIRED",
      HttpStatus.FORBIDDEN,
      `This operation requires ${required} in the study`,
    ),

  /**
   * Returned when a study does not exist AND when the caller may not see it.
   * A distinct "forbidden" would confirm that a study with that id exists,
   * which is a membership oracle across research groups.
   */
  studyNotFound: () => new ApiException("STUDY_NOT_FOUND", HttpStatus.NOT_FOUND, "Study not found"),

  notFound: (what = "Resource") =>
    new ApiException("NOT_FOUND", HttpStatus.NOT_FOUND, `${what} not found`),

  conflict: (message: string) => new ApiException("CONFLICT", HttpStatus.CONFLICT, message),

  invalidStudyTransition: (from: string, to: string) =>
    new ApiException(
      "INVALID_STUDY_TRANSITION",
      HttpStatus.CONFLICT,
      `A study cannot move from ${from} to ${to}`,
    ),

  lastOwnerRequired: () =>
    new ApiException(
      "LAST_OWNER_REQUIRED",
      HttpStatus.CONFLICT,
      "A study must keep at least one OWNER",
    ),

  enrollmentCodeUnavailable: () =>
    new ApiException(
      "ENROLLMENT_CODE_UNAVAILABLE",
      HttpStatus.INTERNAL_SERVER_ERROR,
      "Could not allocate a unique enrollment code",
    ),

  questionnaireNotFound: () =>
    new ApiException("QUESTIONNAIRE_NOT_FOUND", HttpStatus.NOT_FOUND, "Questionnaire not found"),

  questionNotFound: () =>
    new ApiException("QUESTION_NOT_FOUND", HttpStatus.NOT_FOUND, "Question not found"),

  questionOptionNotFound: () =>
    new ApiException("QUESTION_OPTION_NOT_FOUND", HttpStatus.NOT_FOUND, "Option not found"),

  invalidReorder: (reason: string) =>
    new ApiException("INVALID_REORDER", HttpStatus.CONFLICT, `Invalid reorder request: ${reason}`),

  questionTypeHasNoOptions: (type: string) =>
    new ApiException(
      "QUESTION_TYPE_HAS_NO_OPTIONS",
      HttpStatus.CONFLICT,
      `${type} questions do not support options`,
    ),

  questionnaireEmpty: () =>
    new ApiException(
      "QUESTIONNAIRE_EMPTY",
      HttpStatus.CONFLICT,
      "A questionnaire needs at least one question before it can be published",
    ),

  /**
   * `position` is 1-based and matches the number the builder shows beside the
   * question, so "question 3" means the same thing on both sides.
   */
  questionOptionsRequired: (position: number, minimum: number) =>
    new ApiException(
      "QUESTION_OPTIONS_REQUIRED",
      HttpStatus.CONFLICT,
      `Question ${position} needs at least ${minimum} options before this questionnaire can be published`,
      [{ path: `questions.${position}`, message: `Minimum ${minimum} options` }],
    ),

  protocolNotFound: () =>
    new ApiException("PROTOCOL_NOT_FOUND", HttpStatus.NOT_FOUND, "Protocol not found"),

  protocolStepNotFound: () =>
    new ApiException("PROTOCOL_STEP_NOT_FOUND", HttpStatus.NOT_FOUND, "Protocol step not found"),

  /**
   * A step may only pin an immutable version (ADR-008). Pointing at a draft
   * would mean the instrument a participant answers could change under them
   * after they were enrolled on it.
   */
  questionnaireVersionNotPublished: () =>
    new ApiException(
      "QUESTIONNAIRE_VERSION_NOT_PUBLISHED",
      HttpStatus.CONFLICT,
      "A protocol step can only administer a published questionnaire version",
    ),

  protocolEmpty: () =>
    new ApiException(
      "PROTOCOL_EMPTY",
      HttpStatus.CONFLICT,
      "A protocol needs at least one step before it can be published",
    ),

  protocolTriggerDangling: (stepKey: string) =>
    new ApiException(
      "PROTOCOL_TRIGGER_DANGLING",
      HttpStatus.CONFLICT,
      `Step "${stepKey}" is triggered by a step that is not in this protocol`,
      [{ path: `steps.${stepKey}`, message: "Trigger references a step outside this version" }],
    ),

  protocolTriggerCycle: (cycle: readonly string[]) =>
    new ApiException(
      "PROTOCOL_TRIGGER_CYCLE",
      HttpStatus.CONFLICT,
      `These steps trigger each other in a loop, so none of them can ever start: ${cycle.join(" \u2192 ")}`,
      [{ path: `steps.${cycle[0] ?? ""}`, message: cycle.join(" \u2192 ") }],
    ),

  protocolTriggerNeedsOccurrence: (stepKey: string, referencedStepKey: string, count: number) =>
    new ApiException(
      "PROTOCOL_TRIGGER_NEEDS_OCCURRENCE",
      HttpStatus.CONFLICT,
      `Step "${stepKey}" follows "${referencedStepKey}", which happens ${String(count)} times — it must say which one`,
      [{ path: `steps.${stepKey}`, message: referencedStepKey }],
    ),

  protocolTriggerOccurrenceOutOfRange: (
    stepKey: string,
    referencedStepKey: string,
    count: number,
  ) =>
    new ApiException(
      "PROTOCOL_TRIGGER_OCCURRENCE_OUT_OF_RANGE",
      HttpStatus.CONFLICT,
      `Step "${stepKey}" names an occurrence of "${referencedStepKey}" that does not exist; there are ${String(count)}`,
      [{ path: `steps.${stepKey}`, message: String(count) }],
    ),

  /** FR-48c. See ADR-011 for why this is a prohibition and not a warning. */
  protocolStepCompletionOfRecurring: (stepKey: string, referencedStepKey: string) =>
    new ApiException(
      "PROTOCOL_STEP_COMPLETION_OF_RECURRING",
      HttpStatus.CONFLICT,
      `Step "${stepKey}" is triggered by the completion of "${referencedStepKey}", which repeats. ` +
        "A participant who misses one occurrence would never receive this step at all. " +
        "Anchor it on that block's own start plus a duration, or on a named occurrence becoming available.",
      [{ path: `steps.${stepKey}`, message: referencedStepKey }],
    ),

  protocolDuplicateStepKey: (stepKey: string) =>
    new ApiException(
      "PROTOCOL_DUPLICATE_STEP_KEY",
      HttpStatus.CONFLICT,
      `Two steps share the key "${stepKey}", which would merge their export columns`,
      [{ path: `steps.${stepKey}`, message: "Duplicate step key" }],
    ),

  consentVersionNotFound: () =>
    new ApiException(
      "CONSENT_VERSION_NOT_FOUND",
      HttpStatus.NOT_FOUND,
      "Consent version not found",
    ),

  consentVersionEmpty: () =>
    new ApiException(
      "CONSENT_VERSION_EMPTY",
      HttpStatus.CONFLICT,
      "A consent version needs text in at least one language before it can be published",
    ),

  consentVersionStale: () =>
    new ApiException(
      "CONSENT_VERSION_STALE",
      HttpStatus.CONFLICT,
      "The consent document changed while you were reading it; please review the current one",
    ),

  studyNotAcceptingEnrollments: () =>
    new ApiException(
      "STUDY_NOT_ACCEPTING_ENROLLMENTS",
      HttpStatus.CONFLICT,
      "This study is not accepting new participants",
    ),

  participantNotFound: () =>
    new ApiException("PARTICIPANT_NOT_FOUND", HttpStatus.NOT_FOUND, "Participant not found"),

  participantCodeUnavailable: () =>
    new ApiException(
      "PARTICIPANT_CODE_UNAVAILABLE",
      HttpStatus.CONFLICT,
      "Could not allocate a participant code; please try again",
    ),

  /**
   * One code for absent, unknown, revoked and expired alike. Telling them
   * apart would confirm to a caller that a token they hold once existed.
   */
  participantAuthRequired: () =>
    new ApiException(
      "PARTICIPANT_AUTH_REQUIRED",
      HttpStatus.UNAUTHORIZED,
      "This request needs a valid participant credential",
    ),

  participantWithdrawn: () =>
    new ApiException(
      "PARTICIPANT_WITHDRAWN",
      HttpStatus.FORBIDDEN,
      "This participant has withdrawn from the study",
    ),

  sessionNotFound: () =>
    new ApiException("SESSION_NOT_FOUND", HttpStatus.NOT_FOUND, "Session not found"),

  sessionNotAvailable: () =>
    new ApiException(
      "SESSION_NOT_AVAILABLE",
      HttpStatus.CONFLICT,
      "This questionnaire is not open yet",
    ),

  /**
   * Decided on the server's clock. A participant whose device clock is wrong —
   * or set deliberately — gets exactly this answer, which is what makes a
   * response window a window rather than a suggestion.
   */
  sessionWindowClosed: () =>
    new ApiException(
      "SESSION_WINDOW_CLOSED",
      HttpStatus.CONFLICT,
      "The time window for this questionnaire has closed",
    ),

  sessionAlreadyCompleted: () =>
    new ApiException(
      "SESSION_ALREADY_COMPLETED",
      HttpStatus.CONFLICT,
      "This questionnaire has already been submitted",
    ),

  sessionCancelled: () =>
    new ApiException("SESSION_CANCELLED", HttpStatus.CONFLICT, "This questionnaire was cancelled"),

  answerRejected: (problem: string) =>
    new ApiException(
      "ANSWER_REJECTED",
      HttpStatus.BAD_REQUEST,
      `The submitted answer is not valid for this question: ${problem}`,
      [{ path: "answer", message: problem }],
    ),

  /** Names every missing question, so the interface can mark them all at once. */
  requiredQuestionsUnanswered: (questionKeys: readonly string[]) =>
    new ApiException(
      "REQUIRED_QUESTIONS_UNANSWERED",
      HttpStatus.CONFLICT,
      `${String(questionKeys.length)} required question(s) have not been answered`,
      questionKeys.map((key) => ({ path: `questions.${key}`, message: "required" })),
    ),

  questionSelectionBoundsUnsatisfiable: (position: number) =>
    new ApiException(
      "QUESTION_SELECTION_BOUNDS_UNSATISFIABLE",
      HttpStatus.CONFLICT,
      `Question ${position} asks for more selections than it has options`,
      [{ path: `questions.${position}`, message: "Selection bounds exceed the option count" }],
    ),

  /**
   * No VAPID pair on this deployment (ADR-006).
   *
   * 503 rather than 500: nothing is broken, the capability is simply absent
   * here, and the client's correct response is to carry on without push — a
   * study running without notifications is degraded, not failed.
   */
  pushNotConfigured: () =>
    new ApiException(
      "PUSH_NOT_CONFIGURED",
      HttpStatus.SERVICE_UNAVAILABLE,
      "Web Push is not configured on this deployment",
    ),

  pushSubscriptionNotFound: () =>
    new ApiException(
      "PUSH_SUBSCRIPTION_NOT_FOUND",
      HttpStatus.NOT_FOUND,
      "No such push subscription for this participant",
    ),

  /**
   * One code for expired, already-redeemed, and never-existed alike — the same
   * enumeration reasoning as `participantAuthRequired`. The distinction is
   * recorded for the operator, never returned to the caller.
   */
  handoffCodeInvalid: () =>
    new ApiException(
      "HANDOFF_CODE_INVALID",
      HttpStatus.UNAUTHORIZED,
      "That install link is no longer valid",
    ),

  rateLimited: (retryAfterSeconds: number) =>
    new ApiException(
      "RATE_LIMITED",
      HttpStatus.TOO_MANY_REQUESTS,
      `Too many attempts. Retry in ${retryAfterSeconds}s`,
    ),
} as const;
