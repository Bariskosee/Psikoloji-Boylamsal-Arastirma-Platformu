import { CSRF_COOKIE_NAME } from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { readCookie } from "../../common/cookies.js";
import { hashToken, timingSafeEqualHex } from "../../common/crypto.js";
import type { AuthenticatedRequest } from "./auth.types.js";

/**
 * Read the double-submit proof only for the dashboard origin and only when it
 * is still paired with the authenticated session resolved by the global auth
 * guard. Error details deliberately never contain the presented token.
 */
export function readResearcherCsrfToken(
  request: AuthenticatedRequest,
  researcherOrigin: string,
  expectedTokenHash: string,
): string {
  if (request.headers.origin !== researcherOrigin) {
    throw ApiErrors.csrfFailed("origin not allowed");
  }

  const csrfToken = readCookie(request.cookies, CSRF_COOKIE_NAME);
  if (!csrfToken || !timingSafeEqualHex(hashToken(csrfToken), expectedTokenHash)) {
    throw ApiErrors.csrfFailed("csrf cookie mismatch");
  }

  return csrfToken;
}
