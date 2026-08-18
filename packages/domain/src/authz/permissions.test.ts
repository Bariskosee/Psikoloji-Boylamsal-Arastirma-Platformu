import { describe, expect, it } from "vitest";
import {
  STUDY_PERMISSIONS,
  STUDY_ROLES,
  type StudyPermission,
  type StudyRole,
} from "@lpr/contracts";
import {
  PERMISSION_MINIMUM_ROLE,
  STUDY_ROLES_BY_RANK,
  STUDY_ROLE_RANK,
  atLeast,
  can,
  highestRole,
  permissionsFor,
} from "./permissions.js";

/**
 * The full role × permission matrix, asserted exhaustively.
 *
 * This is the table PLAN.md Phase 2 calls the authorization model that
 * "everything later inherits". Sampling it would leave the untested cells to be
 * discovered in production, so every one of the 4 × 13 combinations is stated
 * explicitly below and cross-checked against the implementation. If a
 * permission is added without updating this table, the completeness test fails.
 */
const EXPECTED: Record<StudyPermission, StudyRole[]> = {
  "study:view": ["VIEWER", "ANALYST", "EDITOR", "OWNER"],
  "participant:view": ["VIEWER", "ANALYST", "EDITOR", "OWNER"],
  "analytics:view": ["VIEWER", "ANALYST", "EDITOR", "OWNER"],

  "response:view": ["ANALYST", "EDITOR", "OWNER"],
  "export:run": ["ANALYST", "EDITOR", "OWNER"],

  "study:edit": ["EDITOR", "OWNER"],
  "questionnaire:edit": ["EDITOR", "OWNER"],
  "protocol:edit": ["EDITOR", "OWNER"],
  "consent:edit": ["EDITOR", "OWNER"],
  "participant:manage": ["EDITOR", "OWNER"],

  "study:lifecycle": ["OWNER"],
  "study:members:manage": ["OWNER"],
  "study:audit:read": ["OWNER"],
};

describe("study permission matrix", () => {
  it("covers every declared permission", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...STUDY_PERMISSIONS].sort());
    expect(Object.keys(PERMISSION_MINIMUM_ROLE).sort()).toEqual([...STUDY_PERMISSIONS].sort());
  });

  for (const permission of STUDY_PERMISSIONS) {
    for (const role of STUDY_ROLES) {
      const allowed = EXPECTED[permission].includes(role);
      it(`${role} ${allowed ? "may" : "may NOT"} ${permission}`, () => {
        expect(can(role, permission)).toBe(allowed);
      });
    }
  }
});

describe("the VIEWER boundary", () => {
  /**
   * REQUIREMENTS.md §5.2: VIEWER sees aggregate monitoring only, with NO
   * response-level access. This is the single most consequential cell in the
   * matrix — it is the difference between a colleague who can watch compliance
   * and one who can read individual psychological answers.
   */
  it("never reaches an individual response or an export", () => {
    expect(can("VIEWER", "response:view")).toBe(false);
    expect(can("VIEWER", "export:run")).toBe(false);
  });

  it("still sees the aggregate monitoring it exists for", () => {
    expect(can("VIEWER", "analytics:view")).toBe(true);
    expect(can("VIEWER", "study:view")).toBe(true);
  });
});

describe("OWNER-only operations", () => {
  it("keeps membership, audit, and lifecycle out of every other role", () => {
    for (const role of ["VIEWER", "ANALYST", "EDITOR"] as const) {
      expect(can(role, "study:members:manage")).toBe(false);
      expect(can(role, "study:audit:read")).toBe(false);
      expect(can(role, "study:lifecycle")).toBe(false);
    }
    expect(can("OWNER", "study:members:manage")).toBe(true);
    expect(can("OWNER", "study:audit:read")).toBe(true);
    expect(can("OWNER", "study:lifecycle")).toBe(true);
  });

  it("gives OWNER everything (REQUIREMENTS.md §5.2)", () => {
    for (const permission of STUDY_PERMISSIONS) {
      expect(can("OWNER", permission)).toBe(true);
    }
  });
});

describe("rank helpers", () => {
  it("orders roles VIEWER < ANALYST < EDITOR < OWNER", () => {
    expect(STUDY_ROLE_RANK.VIEWER).toBeLessThan(STUDY_ROLE_RANK.ANALYST);
    expect(STUDY_ROLE_RANK.ANALYST).toBeLessThan(STUDY_ROLE_RANK.EDITOR);
    expect(STUDY_ROLE_RANK.EDITOR).toBeLessThan(STUDY_ROLE_RANK.OWNER);
  });

  it("atLeast is reflexive and respects the order", () => {
    for (const role of STUDY_ROLES) expect(atLeast(role, role)).toBe(true);
    expect(atLeast("EDITOR", "ANALYST")).toBe(true);
    expect(atLeast("ANALYST", "EDITOR")).toBe(false);
  });

  it("permissionsFor agrees with can() for every role", () => {
    for (const role of STUDY_ROLES) {
      const listed = permissionsFor(role);
      for (const permission of STUDY_PERMISSIONS) {
        expect(listed.includes(permission)).toBe(can(role, permission));
      }
    }
  });

  it("picks the highest role and returns null for no membership", () => {
    expect(highestRole(["VIEWER", "OWNER", "ANALYST"])).toBe("OWNER");
    expect(highestRole(["VIEWER"])).toBe("VIEWER");
    expect(highestRole([])).toBeNull();
  });

  it("lists roles most-privileged first", () => {
    expect(STUDY_ROLES_BY_RANK).toEqual(["OWNER", "EDITOR", "ANALYST", "VIEWER"]);
  });
});
