import { z } from "zod";
import { localeSchema } from "./locale.js";

/**
 * Researcher authentication contracts (PLAN.md Phase 2).
 *
 * Participants never appear here. They authenticate with an opaque continuity
 * credential and have no password at all (NFR-09, ADR-007); mixing the two
 * identity systems into one contract is how a participant password screen gets
 * built by accident.
 */

/**
 * Password bounds.
 *
 * Length is the only *composition* rule. Character-class requirements ("one
 * uppercase, one symbol") measurably push people toward `Password1!` and are
 * discouraged by NIST SP 800-63B; the substantive checks — not reusing the
 * email, not a known-weak string — live in @lpr/domain where they are testable.
 *
 * The upper bound is a denial-of-service guard: argon2id is deliberately
 * expensive, so an unbounded password is an unbounded amount of server CPU.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 200;

export const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH);

/**
 * Email is normalised to lowercase before it reaches the database, so
 * `A@x.org` and `a@x.org` cannot become two accounts. Normalisation happens
 * here, in the shared schema, rather than in each call site.
 */
export const researcherEmailSchema = z.string().trim().toLowerCase().email().max(320); // RFC 5321 maximum path length.

export const loginRequestSchema = z.object({
  email: researcherEmailSchema,
  // Deliberately NOT `passwordSchema`. Validating an existing password against
  // the current policy would reject a login with a message that reveals the
  // policy, and would lock out users whose password predates a policy change.
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** The authenticated researcher, as returned by /api/auth/login and /api/auth/me. */
export const researcherProfileSchema = z.object({
  id: z.string().uuid(),
  email: researcherEmailSchema,
  displayName: z.string(),
  locale: localeSchema,
  /** Grants operational health endpoints only — never research data (§5.2). */
  isAdmin: z.boolean(),
});

export type ResearcherProfile = z.infer<typeof researcherProfileSchema>;

export const loginResponseSchema = z.object({
  user: researcherProfileSchema,
  /**
   * The double-submit CSRF token (STRUCTURE.md §11.5).
   *
   * Also set as a readable (non-HttpOnly) cookie. It is returned in the body
   * so a client can hold it in memory instead of reading `document.cookie` on
   * every request. It is not a secret in the way the session token is: it
   * authorises nothing on its own, it only proves the caller can read a
   * same-site response.
   */
  csrfToken: z.string(),
});

export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(MAX_PASSWORD_LENGTH),
  newPassword: passwordSchema,
});

export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/** Header carrying the double-submit token on state-changing requests. */
/**
 * Password reset (PLAN.md Phase 12, FR-06).
 *
 * ── Why the request carries only an email, and the response carries nothing ─
 * The response to a reset request is IDENTICAL whether or not the address
 * belongs to an account. Anything else turns this endpoint into an oracle that
 * confirms which researchers exist at an institution — a list worth having, and
 * one this platform has no reason to publish. The controller therefore always
 * answers 202, and the difference is only visible in whether an email arrives.
 */
export const requestPasswordResetSchema = z.object({
  email: researcherEmailSchema,
});

export type RequestPasswordResetRequest = z.infer<typeof requestPasswordResetSchema>;

/**
 * 64 lowercase hex characters — 32 bytes of CSPRNG output. Validated by shape
 * before any lookup, so a malformed token costs a regex rather than a query.
 */
export const resetTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const confirmPasswordResetSchema = z.object({
  token: resetTokenSchema,
  newPassword: passwordSchema,
});

export type ConfirmPasswordResetRequest = z.infer<typeof confirmPasswordResetSchema>;

export const CSRF_HEADER = "x-csrf-token";

/** Cookie names. Both are set by the API for its own origin. */
export const SESSION_COOKIE_NAME = "lpr_researcher_session";
export const CSRF_COOKIE_NAME = "lpr_csrf";
