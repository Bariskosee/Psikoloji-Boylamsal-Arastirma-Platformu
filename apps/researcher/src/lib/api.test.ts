import { beforeEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER } from "@lpr/contracts";
import { ApiError, api } from "./api";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  window.localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function loginResponse(csrfToken: string): Response {
  return jsonResponse({
    user: {
      id: "00000000-0000-4000-8000-000000000001",
      email: "researcher@example.org",
      displayName: "Researcher",
      locale: "en",
      isAdmin: false,
    },
    csrfToken,
  });
}

function requestHeaders(callIndex: number): Headers {
  const init = fetchMock.mock.calls[callIndex]?.[1];
  return new Headers(init?.headers);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("researcher CSRF token lifecycle", () => {
  it("uses the login response token after a reload without reading the API cookie", async () => {
    fetchMock.mockResolvedValueOnce(loginResponse("csrf-from-login"));

    await api.login({ email: "researcher@example.org", password: "a password" });

    // A fresh module models a reload/new tab: module memory is gone, while
    // researcher-origin storage is shared. There is intentionally no readable
    // API-origin cookie in this document.
    vi.resetModules();
    const { api: reloadedApi } = await import("./api");
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: "study-1" }));

    await reloadedApi.post("/api/studies", { name: "Study" });

    expect(requestHeaders(1).get(CSRF_HEADER)).toBe("csrf-from-login");
    expect(fetchMock.mock.calls[1]?.[1]?.credentials).toBe("include");
  });

  it("bootstraps a missing researcher-origin token from an authenticated API response", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "recovered-token" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await api.bootstrapCsrf();
    await api.post("/api/studies", { name: "Study" });

    expect(requestHeaders(0).has(CSRF_HEADER)).toBe(false);
    expect(requestHeaders(1).get(CSRF_HEADER)).toBe("recovered-token");
  });

  it("reconciles a non-empty token that belongs to an older API session", async () => {
    fetchMock
      .mockResolvedValueOnce(loginResponse("stale-token"))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "live-session-token" }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await api.login({ email: "researcher@example.org", password: "a password" });
    await api.bootstrapCsrf();
    await api.post("/api/studies", { name: "Study" });

    expect(requestHeaders(1).has(CSRF_HEADER)).toBe(false);
    expect(requestHeaders(2).get(CSRF_HEADER)).toBe("live-session-token");
  });

  it("recovers a stale live-session proof before retrying login once", async () => {
    fetchMock
      .mockResolvedValueOnce(loginResponse("stale-token"))
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "CSRF_FAILED", message: "CSRF failed" } }, 403),
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "current-token" }))
      .mockResolvedValueOnce(loginResponse("new-login-token"));

    await api.login({ email: "researcher@example.org", password: "first password" });
    await api.login({ email: "researcher@example.org", password: "second password" });

    expect(requestHeaders(1).get(CSRF_HEADER)).toBe("stale-token");
    expect(requestHeaders(2).has(CSRF_HEADER)).toBe(false);
    expect(requestHeaders(3).get(CSRF_HEADER)).toBe("current-token");
  });

  it("does not let a delayed bootstrap overwrite a newer login token", async () => {
    const delayedBootstrap = deferred<Response>();
    fetchMock
      .mockImplementationOnce(() => delayedBootstrap.promise)
      .mockResolvedValueOnce(loginResponse("new-login-token"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    const oldBootstrap = api.bootstrapCsrf();

    vi.resetModules();
    const { api: secondTabApi } = await import("./api");
    await secondTabApi.login({ email: "researcher@example.org", password: "a password" });

    delayedBootstrap.resolve(jsonResponse({ csrfToken: "stale-bootstrap-token" }));
    await oldBootstrap;
    await api.post("/api/studies", { name: "Study" });

    expect(requestHeaders(2).get(CSRF_HEADER)).toBe("new-login-token");
  });

  it("reads storage at request time so a second tab's login replaces the token", async () => {
    fetchMock
      .mockResolvedValueOnce(loginResponse("first-token"))
      .mockResolvedValueOnce(loginResponse("second-token"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await api.login({ email: "researcher@example.org", password: "first password" });
    vi.resetModules();
    const { api: secondTabApi } = await import("./api");
    await secondTabApi.login({ email: "researcher@example.org", password: "second password" });

    await api.post("/api/studies", { name: "Study" });

    expect(requestHeaders(2).get(CSRF_HEADER)).toBe("second-token");
  });

  it("clears the token only after logout is confirmed", async () => {
    fetchMock
      .mockResolvedValueOnce(loginResponse("logout-token"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await api.login({ email: "researcher@example.org", password: "a password" });
    await api.logout();
    await api.post("/api/studies", { name: "Study" });

    expect(requestHeaders(1).get(CSRF_HEADER)).toBe("logout-token");
    expect(requestHeaders(2).has(CSRF_HEADER)).toBe(false);
  });

  it("retains the token when logout cannot reach the server so revocation can be retried", async () => {
    fetchMock
      .mockResolvedValueOnce(loginResponse("retry-token"))
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await api.login({ email: "researcher@example.org", password: "a password" });
    await expect(api.logout()).rejects.toMatchObject({ code: "NETWORK_ERROR" });
    await api.logout();

    expect(requestHeaders(2).get(CSRF_HEADER)).toBe("retry-token");
  });

  it("forgets the token when the API reports that the session is unauthenticated", async () => {
    fetchMock
      .mockResolvedValueOnce(loginResponse("expired-token"))
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: "UNAUTHENTICATED", message: "Session expired" } }, 401),
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await api.login({ email: "researcher@example.org", password: "a password" });
    await expect(api.get("/api/auth/me")).rejects.toBeInstanceOf(ApiError);
    await api.post("/api/studies", { name: "Study" });

    expect(requestHeaders(1).has(CSRF_HEADER)).toBe(false);
    expect(requestHeaders(2).has(CSRF_HEADER)).toBe(false);
  });

  it("does not let a delayed 401 clear a newer login token from another tab", async () => {
    const delayedUnauthenticated = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(loginResponse("stale-token"))
      .mockImplementationOnce(() => delayedUnauthenticated.promise)
      .mockResolvedValueOnce(loginResponse("fresh-token"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await api.login({ email: "researcher@example.org", password: "first password" });
    const staleRequest = api.get("/api/auth/me");

    vi.resetModules();
    const { api: secondTabApi } = await import("./api");
    await secondTabApi.login({ email: "researcher@example.org", password: "second password" });

    delayedUnauthenticated.resolve(
      jsonResponse({ error: { code: "UNAUTHENTICATED", message: "Session expired" } }, 401),
    );
    await expect(staleRequest).rejects.toBeInstanceOf(ApiError);

    await api.post("/api/studies", { name: "Study" });
    expect(requestHeaders(3).get(CSRF_HEADER)).toBe("fresh-token");
  });

  it("does not let an older successful logout clear a newer login token", async () => {
    const delayedLogout = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(loginResponse("logout-token"))
      .mockImplementationOnce(() => delayedLogout.promise)
      .mockResolvedValueOnce(loginResponse("new-login-token"))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));

    await api.login({ email: "researcher@example.org", password: "first password" });
    const oldLogout = api.logout();

    vi.resetModules();
    const { api: secondTabApi } = await import("./api");
    await secondTabApi.login({ email: "researcher@example.org", password: "second password" });

    delayedLogout.resolve(new Response(null, { status: 204 }));
    await oldLogout;

    await api.post("/api/studies", { name: "Study" });
    expect(requestHeaders(1).get(CSRF_HEADER)).toBe("logout-token");
    expect(requestHeaders(3).get(CSRF_HEADER)).toBe("new-login-token");
  });
});
