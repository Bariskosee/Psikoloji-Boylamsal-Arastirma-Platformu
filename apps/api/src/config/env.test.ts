import { describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const MINIMAL = { DATABASE_URL: "postgresql://u:p@localhost:5432/db" };

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
});
