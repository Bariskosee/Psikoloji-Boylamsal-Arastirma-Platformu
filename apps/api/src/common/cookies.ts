import type { CookieOptions, Response } from "express";
import { CSRF_COOKIE_NAME, PARTICIPANT_COOKIE_NAME, SESSION_COOKIE_NAME } from "@lpr/contracts";

/**
 * Cookie handling for researcher sessions.
 *
 * ── A note on SameSite=Lax and the two-origin deployment ────────────────────
 * ADR-009 puts the dashboard and the API on separate hostnames. `SameSite` is
 * evaluated per *site* (registrable domain), not per origin, so
 * `research.example.org → api.example.org` is a SAME-SITE request and Lax
 * cookies are sent normally, including on POST.
 *
 * This is a genuine DEPLOYMENT CONSTRAINT, not an incidental detail: if the
 * dashboard and API are ever placed on unrelated registrable domains, Lax
 * silently stops sending the session cookie and every request appears
 * unauthenticated. Keep both under one registrable domain, or the cookie
 * policy has to be reconsidered from scratch (SameSite=None, which weakens
 * the CSRF story that §11.5 depends on).
 */

export interface CookieSettings {
  secure: boolean;
  /** Absolute session lifetime; the cookie should not outlive the session row. */
  maxAgeMs: number;
}

export function setSessionCookie(res: Response, token: string, settings: CookieSettings): void {
  res.cookie(SESSION_COOKIE_NAME, token, {
    ...baseOptions(settings),
    // HttpOnly: script must never be able to read the session token, so an XSS
    // in the dashboard cannot exfiltrate a working session.
    httpOnly: true,
  });
}

export function setCsrfCookie(res: Response, token: string, settings: CookieSettings): void {
  res.cookie(CSRF_COOKIE_NAME, token, {
    ...baseOptions(settings),
    // Deliberately readable by script — that IS the double-submit mechanism.
    // The token authorises nothing on its own; it only proves the caller could
    // read a same-site response, which a cross-site attacker cannot.
    httpOnly: false,
  });
}

/**
 * The participant continuity cookie (STRUCTURE.md §11.3).
 *
 * HttpOnly without exception. The token IS the participant's identity — there
 * is no password behind it — so script must never be able to read it, and it
 * must never reach a URL, a log, or `localStorage`. Everything the participant
 * application needs is served from endpoints that read this cookie; the client
 * never sees the value.
 */
export function setParticipantCookie(res: Response, token: string, settings: CookieSettings): void {
  res.cookie(PARTICIPANT_COOKIE_NAME, token, { ...baseOptions(settings), httpOnly: true });
}

export function clearParticipantCookie(res: Response, settings: CookieSettings): void {
  res.clearCookie(PARTICIPANT_COOKIE_NAME, {
    ...baseOptions(settings),
    maxAge: undefined,
    httpOnly: true,
  });
}

export function clearAuthCookies(res: Response, settings: CookieSettings): void {
  const options = { ...baseOptions(settings), maxAge: undefined };
  res.clearCookie(SESSION_COOKIE_NAME, { ...options, httpOnly: true });
  res.clearCookie(CSRF_COOKIE_NAME, { ...options, httpOnly: false });
}

function baseOptions(settings: CookieSettings): CookieOptions {
  return {
    secure: settings.secure,
    sameSite: "lax",
    path: "/",
    maxAge: settings.maxAgeMs,
    // No `domain`: a host-only cookie is sent to the API host and nowhere
    // else. Setting `.example.org` would broadcast the session to every
    // subdomain, including the public participant application.
  };
}

export function readCookie(cookies: unknown, name: string): string | undefined {
  if (!cookies || typeof cookies !== "object") return undefined;
  const value = (cookies as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
}
