import { describe, expect, it } from "vitest";
import {
  PUSH_SUBSCRIPTION_RETENTION_DAYS,
  hasExpired,
  isPrunable,
  pruneCutoff,
} from "./retention.js";

/**
 * When a push subscription stops being ours to keep.
 *
 * The distinction these tests protect is between "the push service said this
 * would expire" and "we have marked it dead". Only the second starts the
 * retention clock, and collapsing them would delete the evidence in the same
 * moment it became interesting.
 */
describe("push subscription retention", () => {
  const DAY = 86_400_000;
  const now = new Date("2026-09-01T12:00:00Z");

  it("never prunes an active subscription", () => {
    expect(isPrunable({ isActive: true, deactivatedAt: null, expirationTime: null }, now)).toBe(
      false,
    );
  });

  it("never prunes an active subscription whose stated expiry has passed", () => {
    // "The push service said this would expire" and "we have marked it dead"
    // are different facts, and only the second starts the retention clock.
    const state = {
      isActive: true,
      deactivatedAt: null,
      expirationTime: new Date(now.getTime() - 30 * DAY),
    };

    expect(hasExpired(state, now)).toBe(true);
    expect(isPrunable(state, now)).toBe(false);
  });

  it("prunes only after the full retention window", () => {
    const justInside = {
      isActive: false,
      deactivatedAt: new Date(now.getTime() - (PUSH_SUBSCRIPTION_RETENTION_DAYS * DAY - 1)),
      expirationTime: null,
    };
    const exactlyAt = {
      isActive: false,
      deactivatedAt: new Date(now.getTime() - PUSH_SUBSCRIPTION_RETENTION_DAYS * DAY),
      expirationTime: null,
    };

    expect(isPrunable(justInside, now)).toBe(false);
    expect(isPrunable(exactlyAt, now)).toBe(true);
  });

  it("keeps an inactive row that never recorded when it died", () => {
    // A data defect, not a prunable row. Deleting on missing evidence is how a
    // bug quietly erases what would have explained it.
    expect(isPrunable({ isActive: false, deactivatedAt: null, expirationTime: null }, now)).toBe(
      false,
    );
  });

  it("reports no expiry when the push service stated none", () => {
    // The usual case — Chrome and Firefox leave it unset — which is why expiry
    // can never be the only way a dead subscription is noticed.
    expect(hasExpired({ isActive: true, deactivatedAt: null, expirationTime: null }, now)).toBe(
      false,
    );
  });

  it("computes a cutoff the sweeper can compare rows against", () => {
    expect(pruneCutoff(now).toISOString()).toBe(
      new Date(now.getTime() - PUSH_SUBSCRIPTION_RETENTION_DAYS * DAY).toISOString(),
    );
  });
});
