import { Injectable } from "@nestjs/common";

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiting for abuse-sensitive endpoints (STRUCTURE.md
 * §11.5): login 5 per 15 minutes, and — from Phase 5 — enrollment, recovery,
 * and push registration.
 *
 * ── Scope and its limit, stated plainly ─────────────────────────────────────
 * The counters live IN PROCESS. With one API instance, which is the MVP
 * deployment (ADR-010), that is exactly correct. With several instances an
 * attacker gets N times the budget, and a deploy resets every counter.
 *
 * This is a deliberate MVP-sized choice, not an oversight. The alternative — a
 * counter table in PostgreSQL — adds a write to every login attempt including
 * the failures an attacker generates, which is its own denial-of-service
 * surface. Phase 12 hardening is where a shared store belongs, together with
 * the decision about whether the API is ever horizontally scaled.
 *
 * The interface is deliberately store-shaped so that change is a provider
 * swap rather than a rewrite of every call site.
 */
@Injectable()
export class RateLimitService {
  private readonly windows = new Map<string, { count: number; resetAtMs: number }>();

  /**
   * Records an attempt and reports whether it may proceed.
   *
   * `nowMs` is a parameter rather than a `Date.now()` call so the behaviour is
   * testable without waiting fifteen real minutes.
   */
  hit(key: string, limit: number, windowMs: number, nowMs: number): RateLimitDecision {
    this.evictExpired(nowMs);

    const existing = this.windows.get(key);
    if (!existing || existing.resetAtMs <= nowMs) {
      this.windows.set(key, { count: 1, resetAtMs: nowMs + windowMs });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    existing.count += 1;
    if (existing.count > limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAtMs - nowMs) / 1000)),
      };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Called after a successful login, so one success clears the budget. */
  reset(key: string): void {
    this.windows.delete(key);
  }

  /**
   * Drops every window.
   *
   * Used by integration tests, which all originate from one loopback address
   * and would otherwise exhaust the shared per-IP budget partway through the
   * suite — a failure that looks like a bug in whichever test ran sixth.
   * Also usable operationally to lift a lockout without a restart.
   */
  clear(): void {
    this.windows.clear();
  }

  /**
   * Drops elapsed windows.
   *
   * Without this the map grows once per distinct key forever, and the keys
   * include attacker-supplied emails — an unbounded memory leak driven by
   * unauthenticated input.
   */
  private evictExpired(nowMs: number): void {
    if (this.windows.size < 1000) return;
    for (const [key, window] of this.windows) {
      if (window.resetAtMs <= nowMs) this.windows.delete(key);
    }
  }
}
