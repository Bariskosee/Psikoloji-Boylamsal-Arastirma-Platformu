import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { CSRF_HEADER } from "@lpr/contracts";
import { ApiErrors } from "../../../common/api-error.js";
import { hashToken, timingSafeEqualHex } from "../../../common/crypto.js";
import { loadEnv } from "../../../config/env.js";
import type { AuthenticatedRequest } from "../auth.types.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF protection: origin check + double-submit token (STRUCTURE.md §11.5).
 *
 * Two independent layers, because each covers the other's gap:
 *
 * **Origin/Referer check** runs on every state-changing request, INCLUDING
 * login. Login needs it too — an attacker who can forge a cross-site login
 * request can sign a victim into the ATTACKER'S account and then read whatever
 * the victim does next. But some clients omit both headers, so it cannot be
 * the only control.
 *
 * **Double-submit token** requires the caller to echo a value it could only
 * have read from a same-site response. It applies once a session exists.
 *
 * SameSite=Lax is the third layer, in the cookie itself. Lax is not sufficient
 * alone: it does not constrain requests from a subdomain, and this deployment
 * puts the public participant application on a sibling subdomain of the
 * dashboard (ADR-009).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly env = loadEnv();

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (SAFE_METHODS.has(request.method)) return true;

    this.checkOrigin(request);
    this.checkDoubleSubmit(request);
    return true;
  }

  private checkOrigin(request: AuthenticatedRequest): void {
    const origin = request.headers.origin;
    const referer = request.headers.referer;
    const allowed = [this.env.RESEARCHER_ORIGIN, this.env.PARTICIPANT_ORIGIN];

    if (typeof origin === "string" && origin.length > 0) {
      if (!allowed.includes(origin)) throw ApiErrors.csrfFailed("origin not allowed");
      return;
    }

    if (typeof referer === "string" && referer.length > 0) {
      const refererOrigin = safeOrigin(referer);
      if (!refererOrigin || !allowed.includes(refererOrigin)) {
        throw ApiErrors.csrfFailed("referer not allowed");
      }
      return;
    }

    // Neither header present. Rejecting is the safe default: every browser
    // sends Origin on a cross-origin state-changing fetch, so an absent
    // Origin on a mutation is either a non-browser client — which should use
    // an API token, once one exists — or a forgery attempt.
    throw ApiErrors.csrfFailed("missing origin and referer");
  }

  private checkDoubleSubmit(request: AuthenticatedRequest): void {
    // No session means no cookie to ride on, so there is nothing to forge
    // against. The origin check above still applies.
    if (!request.auth) return;

    const presented = request.headers[CSRF_HEADER];
    if (typeof presented !== "string" || presented.length === 0) {
      throw ApiErrors.csrfFailed("missing csrf token");
    }

    // Constant time: a `===` here leaks how many leading characters matched,
    // which is enough to rebuild the token one character at a time.
    if (!timingSafeEqualHex(hashToken(presented), request.auth.csrfTokenHash)) {
      throw ApiErrors.csrfFailed("csrf token mismatch");
    }
  }
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
