import { describe, expect, it } from "vitest";
import { STUDY_STATUSES, type StudyStatus } from "@lpr/contracts";
import {
  acceptsConfigurationChanges,
  acceptsEnrollment,
  canTransitionStudy,
  nextStudyStatuses,
} from "./lifecycle.js";

/**
 * The complete 5 × 5 transition table.
 *
 * Every legal transition has a passing test and every forbidden one has a test
 * asserting rejection — the same standard PLAN.md sets for the session state
 * machine, applied here because the study lifecycle gates enrollment and
 * therefore gates data collection.
 */
const LEGAL: ReadonlyArray<[StudyStatus, StudyStatus]> = [
  ["DRAFT", "ACTIVE"],
  ["DRAFT", "ARCHIVED"],
  ["ACTIVE", "PAUSED"],
  ["ACTIVE", "CLOSED"],
  ["PAUSED", "ACTIVE"],
  ["PAUSED", "CLOSED"],
  ["CLOSED", "ARCHIVED"],
];

const isLegal = (from: StudyStatus, to: StudyStatus): boolean =>
  LEGAL.some(([f, t]) => f === from && t === to);

describe("study lifecycle transitions", () => {
  for (const from of STUDY_STATUSES) {
    for (const to of STUDY_STATUSES) {
      if (from === to) continue;
      const expected = isLegal(from, to);
      it(`${from} → ${to} is ${expected ? "allowed" : "rejected"}`, () => {
        expect(canTransitionStudy(from, to).ok).toBe(expected);
      });
    }
  }

  it("rejects a no-op transition with a distinct reason", () => {
    for (const status of STUDY_STATUSES) {
      expect(canTransitionStudy(status, status)).toEqual({ ok: false, reason: "SAME_STATUS" });
    }
  });

  it("never leaves ARCHIVED", () => {
    for (const to of STUDY_STATUSES) {
      if (to === "ARCHIVED") continue;
      expect(canTransitionStudy("ARCHIVED", to)).toEqual({ ok: false, reason: "TERMINAL_STATUS" });
    }
    expect(nextStudyStatuses("ARCHIVED")).toEqual([]);
  });

  it("never reopens a closed study", () => {
    // Reopening would resume a schedule whose windows have already passed:
    // sessions would appear and expire in the same instant, and the compliance
    // denominator would stop describing what participants were asked to do.
    expect(canTransitionStudy("CLOSED", "ACTIVE").ok).toBe(false);
    expect(canTransitionStudy("CLOSED", "PAUSED").ok).toBe(false);
  });

  it("never returns to DRAFT", () => {
    for (const from of STUDY_STATUSES) {
      if (from === "DRAFT") continue;
      expect(canTransitionStudy(from, "DRAFT").ok).toBe(false);
    }
  });

  it("reports the legal next statuses for the interface", () => {
    expect(nextStudyStatuses("DRAFT")).toEqual(["ACTIVE", "ARCHIVED"]);
    expect(nextStudyStatuses("ACTIVE")).toEqual(["PAUSED", "CLOSED"]);
    expect(nextStudyStatuses("PAUSED")).toEqual(["ACTIVE", "CLOSED"]);
    expect(nextStudyStatuses("CLOSED")).toEqual(["ARCHIVED"]);
  });
});

describe("enrollment gating", () => {
  it("accepts enrollment only while ACTIVE", () => {
    for (const status of STUDY_STATUSES) {
      expect(acceptsEnrollment(status)).toBe(status === "ACTIVE");
    }
  });

  it("allows configuration changes before the study ends", () => {
    expect(acceptsConfigurationChanges("DRAFT")).toBe(true);
    expect(acceptsConfigurationChanges("ACTIVE")).toBe(true);
    expect(acceptsConfigurationChanges("PAUSED")).toBe(true);
    expect(acceptsConfigurationChanges("CLOSED")).toBe(false);
    expect(acceptsConfigurationChanges("ARCHIVED")).toBe(false);
  });
});
