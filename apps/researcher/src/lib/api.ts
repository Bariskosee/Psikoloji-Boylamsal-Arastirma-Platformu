"use client";

import { CSRF_COOKIE_NAME, CSRF_HEADER, type ApiErrorCode } from "@lpr/contracts";

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
 * The double-submit CSRF token, read from the cookie the API set.
 *
 * Read at call time rather than cached, so it stays correct across a login,
 * a logout, and a second login in the same tab.
 */
function csrfToken(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie
    .split("; ")
    .find((entry) => entry.startsWith(`${CSRF_COOKIE_NAME}=`));
  return match ? decodeURIComponent(match.slice(CSRF_COOKIE_NAME.length + 1)) : null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = csrfToken();

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

export const api = {
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
