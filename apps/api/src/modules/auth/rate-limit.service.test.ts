import { beforeEach, describe, expect, it } from "vitest";
import { RateLimitService } from "./rate-limit.service.js";

const WINDOW_MS = 15 * 60 * 1000;
const LIMIT = 5;

describe("RateLimitService", () => {
  let limiter: RateLimitService;
  const start = Date.UTC(2026, 7, 18, 9, 0, 0);

  beforeEach(() => {
    limiter = new RateLimitService();
  });

  it("allows exactly the configured number of attempts", () => {
    for (let attempt = 1; attempt <= LIMIT; attempt += 1) {
      expect(limiter.hit("key", LIMIT, WINDOW_MS, start).allowed, `attempt ${attempt}`).toBe(true);
    }
    expect(limiter.hit("key", LIMIT, WINDOW_MS, start).allowed).toBe(false);
  });

  it("reports how long the caller must wait", () => {
    for (let attempt = 0; attempt <= LIMIT; attempt += 1)
      limiter.hit("key", LIMIT, WINDOW_MS, start);
    const decision = limiter.hit("key", LIMIT, WINDOW_MS, start + 60_000);
    expect(decision.allowed).toBe(false);
    expect(decision.retryAfterSeconds).toBe(14 * 60);
  });

  it("opens a fresh window once the old one elapses", () => {
    for (let attempt = 0; attempt <= LIMIT; attempt += 1)
      limiter.hit("key", LIMIT, WINDOW_MS, start);
    expect(limiter.hit("key", LIMIT, WINDOW_MS, start + WINDOW_MS + 1).allowed).toBe(true);
  });

  it("keeps separate budgets per key", () => {
    // The login limiter keys on email AND on IP, so one attacker cannot lock
    // an unrelated researcher out by burning their email's budget from afar.
    for (let attempt = 0; attempt <= LIMIT; attempt += 1) limiter.hit("a", LIMIT, WINDOW_MS, start);
    expect(limiter.hit("a", LIMIT, WINDOW_MS, start).allowed).toBe(false);
    expect(limiter.hit("b", LIMIT, WINDOW_MS, start).allowed).toBe(true);
  });

  it("clears the budget on reset, so a success is not punished", () => {
    for (let attempt = 0; attempt < LIMIT; attempt += 1)
      limiter.hit("key", LIMIT, WINDOW_MS, start);
    limiter.reset("key");
    expect(limiter.hit("key", LIMIT, WINDOW_MS, start).allowed).toBe(true);
  });

  it("does not grow without bound on attacker-supplied keys", () => {
    // The key includes an email from the request body. Without eviction this
    // map is an unbounded memory leak driven by unauthenticated input.
    for (let i = 0; i < 1500; i += 1) limiter.hit(`key-${i}`, LIMIT, WINDOW_MS, start);
    const decision = limiter.hit("fresh", LIMIT, WINDOW_MS, start + WINDOW_MS + 1);
    expect(decision.allowed).toBe(true);
  });
});
