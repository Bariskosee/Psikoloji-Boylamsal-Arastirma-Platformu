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

  rateLimited: (retryAfterSeconds: number) =>
    new ApiException(
      "RATE_LIMITED",
      HttpStatus.TOO_MANY_REQUESTS,
      `Too many attempts. Retry in ${retryAfterSeconds}s`,
    ),
} as const;
