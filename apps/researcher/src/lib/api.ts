"use client";

import {
  CSRF_HEADER,
  type ApiErrorCode,
  type CsrfTokenResponse,
  type LoginRequest,
  type LoginResponse,
} from "@lpr/contracts";

/**
 * The dashboard's only channel to the server.
 *
 * ── Why every dashboard fetch happens in the BROWSER ─────────────────────────
 * The session cookie is set by the API for the API's own host (ADR-009). A
 * Next.js Server Component runs on the dashboard's server, which never receives
 * that cookie, so server-side fetching would be permanently unauthenticated.
 * Every data-loading screen here is therefore a client component. This is a
 * consequence of the two-origin split, not an oversight.
 *
 * SameSite=Lax still sends the cookie because both hosts share one registrable
 * domain — see the deployment constraint in the API's cookie module.
 */
const API_URL = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";
const CSRF_STORAGE_KEY = "lpr_researcher_csrf";

/**
 * A fallback for browsers that make Web Storage unavailable.
 *
 * It preserves mutations during the current client-side navigation only. The
 * normal path is localStorage, because the API session cookie is persistent
 * and shared by tabs too; the matching CSRF proof must survive the same
 * reloads and tabs or an otherwise valid session becomes read-only.
 */
let inMemoryCsrfToken: string | null = null;
let storageUnavailable = false;

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode | "NETWORK_ERROR",
    readonly status: number,
    message: string,
    readonly details?: Array<{ path: string; message: string }>,
  ) {
    super(message);
  }
}

/**
 * The double-submit CSRF token returned by the login response.
 *
 * ADR-009 deliberately puts the dashboard and API on different origins, and
 * the API cookie is deliberately host-only. Consequently dashboard script
 * cannot read the API's CSRF cookie. The response token is persisted on the
 * researcher origin instead and read at call time so a login or logout in one
 * tab takes effect in every other tab before its next mutation.
 *
 * localStorage is acceptable for this value only: it is not a bearer
 * credential and authorises nothing without the HttpOnly API session cookie
 * plus an allowed Origin. Session and participant credentials must never use
 * this storage path.
 */
function csrfToken(): string | null {
  if (typeof window === "undefined" || storageUnavailable) return inMemoryCsrfToken;
  try {
    return window.localStorage.getItem(CSRF_STORAGE_KEY);
  } catch {
    storageUnavailable = true;
    return inMemoryCsrfToken;
  }
}

function rememberCsrfToken(token: string): void {
  inMemoryCsrfToken = token;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CSRF_STORAGE_KEY, token);
    storageUnavailable = false;
  } catch {
    storageUnavailable = true;
  }
}

function forgetCsrfToken(): void {
  inMemoryCsrfToken = null;
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CSRF_STORAGE_KEY);
    storageUnavailable = false;
  } catch {
    storageUnavailable = true;
  }
}

type CsrfTokenSnapshot = Readonly<{ value: string | null }>;

/**
 * A request keeps the token generation it started with, even for GETs that do
 * not send the token. A response can arrive after another tab has logged in,
 * so response-time cleanup must be tied to this snapshot rather than whatever
 * token happens to be current then.
 */
function captureCsrfToken(): CsrfTokenSnapshot {
  return { value: csrfToken() };
}

function forgetCsrfTokenIfCurrent(snapshot: CsrfTokenSnapshot): void {
  if (csrfToken() !== snapshot.value) return;
  forgetCsrfToken();
}

function rememberCsrfTokenIfCurrent(snapshot: CsrfTokenSnapshot, token: string): void {
  if (csrfToken() !== snapshot.value) return;
  rememberCsrfToken(token);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  csrfAtStart = captureCsrfToken(),
): Promise<T> {
  // Do not put the token on read-only traffic. It is needed only for the
  // server's state-changing-request check, and sending it less often also
  // keeps it out of routine request metadata.
  const token = method === "GET" ? null : csrfAtStart.value;

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      // Without this the browser sends no cookie at all cross-origin, and every
      // request looks unauthenticated.
      credentials: "include",
      headers: {
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { [CSRF_HEADER]: token } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    // A dead network is not a 500 — the interface should say "you appear to be
    // offline", not "the server failed".
    throw new ApiError("NETWORK_ERROR", 0, "Could not reach the server");
  }

  // A 401 invalidates only the CSRF proof paired with the request that failed.
  // A delayed response from an older session must not erase a newer login in
  // this or another tab.
  if (response.status === 401) forgetCsrfTokenIfCurrent(csrfAtStart);

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const error = (payload as { error?: { code: ApiErrorCode; message: string; details?: [] } })
      ?.error;
    throw new ApiError(
      error?.code ?? "INTERNAL_ERROR",
      response.status,
      error?.message ?? "Request failed",
      error?.details,
    );
  }

  return payload as T;
}

async function bootstrapCsrf(): Promise<void> {
  const csrfAtStart = captureCsrfToken();
  const response = await request<CsrfTokenResponse>(
    "GET",
    "/api/auth/csrf",
    undefined,
    csrfAtStart,
  );
  // Always reconcile, even when storage was non-empty. Another tab can replace
  // the host-only session cookie while this tab still holds the previous
  // session's proof. The snapshot prevents a slower response from overwriting
  // a still-newer login.
  rememberCsrfTokenIfCurrent(csrfAtStart, response.csrfToken);
}

async function login(body: LoginRequest): Promise<LoginResponse> {
  let response: LoginResponse;
  try {
    response = await request<LoginResponse>("POST", "/api/auth/login", body);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "CSRF_FAILED") throw error;

    // A live API session paired with a stale researcher-origin proof makes the
    // first login attempt fail before the controller runs. Reconcile from the
    // authenticated, exact-origin endpoint and retry once; CSRF_FAILED is
    // raised by a guard, so the rejected attempt cannot have changed state.
    await bootstrapCsrf();
    response = await request<LoginResponse>("POST", "/api/auth/login", body);
  }
  rememberCsrfToken(response.csrfToken);
  return response;
}

export const api = {
  bootstrapCsrf,
  login,
  logout: async (): Promise<void> => {
    const csrfAtStart = captureCsrfToken();
    await request<void>("POST", "/api/auth/logout", undefined, csrfAtStart);
    // Clear only after the API confirms revocation. On a network failure the
    // session can still be live, so retaining the token lets the user retry.
    // The conditional also protects a login completed in another tab while
    // this logout request was in flight.
    forgetCsrfTokenIfCurrent(csrfAtStart);
  },
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};

/** Absolute URL for resources the browser loads directly, such as the QR SVG. */
export function apiUrl(path: string): string {
  return `${API_URL}${path}`;
}
