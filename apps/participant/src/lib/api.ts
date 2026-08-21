"use client";

/**
 * The participant API client.
 *
 * Every call is made from the BROWSER, never from a Server Component. The
 * continuity cookie belongs to the API host, so a server-rendered request
 * carries no identity and would always look like a stranger (ADR-009) — the
 * same constraint the researcher dashboard works under.
 *
 * `credentials: "include"` on every request is what sends the cookie. There is
 * no token to attach: the client never sees one, and there is nothing here that
 * could read, store, or log it.
 *
 * No CSRF token either. The double-submit mechanism rides on a researcher
 * session; participant routes are protected by the API's origin check plus the
 * cookie's SameSite=Lax.
 */

const BASE_URL = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:3001";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = "ApiError";
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, {
      method,
      credentials: "include",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // A dropped connection is not an application error and must not be
    // rendered as one: on a phone it usually means a tunnel or a lift.
    throw new ApiError("NETWORK_ERROR", 0);
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const code =
      typeof payload === "object" && payload !== null
        ? ((payload as { error?: { code?: string } }).error?.code ?? "UNKNOWN")
        : "UNKNOWN";
    throw new ApiError(code, response.status);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>("GET", path),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
};
