import { describe, expect, it } from "vitest";
import { generateToken, hashIp, hashToken, timingSafeEqualHex } from "./crypto.js";

describe("generateToken", () => {
  it("produces a URL-safe token with no padding", () => {
    const token = generateToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("never repeats across a large sample", () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => generateToken()));
    expect(tokens.size).toBe(1000);
  });

  it("carries at least 256 bits by default", () => {
    // 32 bytes → 43 base64url characters.
    expect(generateToken().length).toBeGreaterThanOrEqual(43);
  });
});

describe("hashToken", () => {
  it("is deterministic, so a presented token can be looked up", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });

  it("does not contain the token it hashes", () => {
    // The point of storing the hash: a dump of the session table must not be
    // replayable as a login.
    expect(hashToken("secret-token-value")).not.toContain("secret-token-value");
    expect(hashToken("abc")).toHaveLength(64);
  });

  it("separates tokens differing by one character", () => {
    expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
  });
});

describe("hashIp", () => {
  it("returns null for a missing address rather than hashing an empty string", () => {
    expect(hashIp(undefined, "secret")).toBeNull();
  });

  it("is keyed, so the same address hashes differently under a rotated secret", () => {
    // An unkeyed hash of an IPv4 address is not pseudonymous: the whole space
    // is enumerable in seconds.
    expect(hashIp("203.0.113.5", "secret-one")).not.toBe(hashIp("203.0.113.5", "secret-two"));
  });

  it("is stable for one address under one secret", () => {
    expect(hashIp("203.0.113.5", "secret")).toBe(hashIp("203.0.113.5", "secret"));
  });

  it("never returns the address itself", () => {
    expect(hashIp("203.0.113.5", "secret")).not.toContain("203.0.113");
  });
});

describe("timingSafeEqualHex", () => {
  it("matches identical values", () => {
    expect(timingSafeEqualHex("deadbeef", "deadbeef")).toBe(true);
  });

  it("rejects different values of the same length", () => {
    expect(timingSafeEqualHex("deadbeef", "deadbeee")).toBe(false);
  });

  it("rejects different lengths without throwing", () => {
    // timingSafeEqual itself throws on a length mismatch; that would surface as
    // a 500 on a malformed CSRF header instead of a clean rejection.
    expect(timingSafeEqualHex("deadbeef", "dead")).toBe(false);
    expect(timingSafeEqualHex("", "dead")).toBe(false);
  });
});
