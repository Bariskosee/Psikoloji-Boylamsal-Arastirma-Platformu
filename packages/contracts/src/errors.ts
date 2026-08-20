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
