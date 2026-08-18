import { describe, expect, it } from "vitest";
import { loadEnv, shouldUseSecureCookies } from "./env.js";

const MINIMAL = {
  DATABASE_URL: "postgresql://u:p@localhost:5432/db",
  SESSION_SECRET: "x".repeat(32),
};

describe("loadEnv", () => {
  it("accepts a minimal valid environment and applies defaults", () => {
    const env = loadEnv(MINIMAL as NodeJS.ProcessEnv);
    expect(env.API_PORT).toBe(3001);
    expect(env.NODE_ENV).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("refuses to start without a database URL", () => {
    expect(() => loadEnv({} as NodeJS.ProcessEnv)).toThrow(/DATABASE_URL/);
  });

  it("rejects a non-numeric port rather than silently defaulting", () => {
    expect(() => loadEnv({ ...MINIMAL, API_PORT: "not-a-port" } as NodeJS.ProcessEnv)).toThrow(
      /API_PORT/,
    );
  });

  it("rejects a malformed origin", () => {
    expect(() =>
      loadEnv({ ...MINIMAL, PARTICIPANT_ORIGIN: "notaurl" } as NodeJS.ProcessEnv),
    ).toThrow(/PARTICIPANT_ORIGIN/);
  });

  it("refuses to start without a session secret rather than inventing one", () => {
    // A session secret with a fallback is not a secret, and the failure would
    // be silent: sessions would still work, they would just be forgeable.
    const { SESSION_SECRET: _omitted, ...withoutSecret } = MINIMAL;
    expect(() => loadEnv(withoutSecret as NodeJS.ProcessEnv)).toThrow(/SESSION_SECRET/);
  });

  it("rejects a session secret short enough to brute-force", () => {
    expect(() => loadEnv({ ...MINIMAL, SESSION_SECRET: "too-short" } as NodeJS.ProcessEnv)).toThrow(
      /SESSION_SECRET/,
    );
  });

  it("applies session lifetime defaults", () => {
    const env = loadEnv(MINIMAL as NodeJS.ProcessEnv);
    expect(env.SESSION_ABSOLUTE_TTL_HOURS).toBe(12);
    expect(env.SESSION_IDLE_TIMEOUT_MINUTES).toBe(120);
    expect(env.LOGIN_RATE_LIMIT_MAX).toBe(5);
  });
});

describe("shouldUseSecureCookies", () => {
  it("is off in development, so local login works in Safari too", () => {
    expect(shouldUseSecureCookies(loadEnv(MINIMAL as NodeJS.ProcessEnv))).toBe(false);
  });

  it("is on everywhere else", () => {
    for (const NODE_ENV of ["production", "test"] as const) {
      expect(shouldUseSecureCookies(loadEnv({ ...MINIMAL, NODE_ENV } as NodeJS.ProcessEnv))).toBe(
        true,
      );
    }
  });

  it("lets an explicit setting win in both directions", () => {
    expect(
      shouldUseSecureCookies(
        loadEnv({
          ...MINIMAL,
          NODE_ENV: "production",
          COOKIE_SECURE: "false",
        } as NodeJS.ProcessEnv),
      ),
    ).toBe(false);
    expect(
      shouldUseSecureCookies(loadEnv({ ...MINIMAL, COOKIE_SECURE: "true" } as NodeJS.ProcessEnv)),
    ).toBe(true);
  });
});
