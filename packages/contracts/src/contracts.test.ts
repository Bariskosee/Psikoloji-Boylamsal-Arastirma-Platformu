import { describe, expect, it } from "vitest";
import { healthResponseSchema, readyResponseSchema } from "./health.js";
import { DEFAULT_LOCALE, LOCALES, isLocale, localeSchema } from "./locale.js";

describe("locale contract", () => {
  it("supports exactly Turkish and English (FR-37)", () => {
    expect([...LOCALES]).toEqual(["en", "tr"]);
  });

  it("defaults to English", () => {
    expect(DEFAULT_LOCALE).toBe("en");
  });

  it("accepts supported locales and rejects everything else", () => {
    expect(isLocale("tr")).toBe(true);
    expect(isLocale("en")).toBe(true);
    expect(isLocale("de")).toBe(false);
    expect(isLocale("EN")).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(isLocale(null)).toBe(false);
    expect(localeSchema.safeParse("tr-TR").success).toBe(false);
  });
});

describe("health contract", () => {
  it("accepts a well-formed liveness response", () => {
    const parsed = healthResponseSchema.parse({
      status: "ok",
      service: "api",
      version: "0.0.0",
      uptimeSeconds: 12,
    });
    expect(parsed.status).toBe("ok");
  });

  it("rejects a negative uptime", () => {
    expect(() =>
      healthResponseSchema.parse({
        status: "ok",
        service: "api",
        version: "0.0.0",
        uptimeSeconds: -1,
      }),
    ).toThrow();
  });
});

describe("ready contract", () => {
  it("carries per-dependency detail so a failure is diagnosable", () => {
    const parsed = readyResponseSchema.parse({
      ready: false,
      service: "api",
      checks: [{ name: "postgres", ok: false, latencyMs: 5001, error: "timeout" }],
    });
    expect(parsed.ready).toBe(false);
    expect(parsed.checks[0]?.error).toBe("timeout");
  });

  it("requires the checks array even when everything is healthy", () => {
    expect(() => readyResponseSchema.parse({ ready: true, service: "api" })).toThrow();
  });
});
