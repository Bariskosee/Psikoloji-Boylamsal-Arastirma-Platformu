import {
  STUDY_PERMISSIONS,
  STUDY_ROLES,
  type StudyPermission,
  type StudyRole,
} from "@lpr/contracts";

/**
 * The authorization model. Phase 2 establishes it; every later phase inherits
 * it (PLAN.md Phase 2), so it is defined once, here, as pure data.
 *
 * It lives in @lpr/domain rather than in a NestJS guard for one reason: a
 * permission table that can only be exercised by starting an HTTP server is a
 * permission table that gets tested thinly. This one is a pure function over
 * two enums, so the entire role × permission matrix is asserted exhaustively in
 * microseconds — including the combinations nobody thought to write an
 * endpoint test for.
 */

/**
 * Roles are LINEARLY ORDERED. `VIEWER < ANALYST < EDITOR < OWNER`.
 *
 * STRUCTURE.md §12 writes endpoint requirements as `VIEWER+` and `ANALYST+`,
 * which only means anything under a linear order, and REQUIREMENTS.md §5.2
 * gives OWNER "everything". A non-linear model (an EDITOR who may build but
 * may not export) is defensible and may be wanted later, but it is a
 * finer-grained permission matrix — explicitly out of MVP scope in §5.2.
 *
 * The rank is never persisted. Only the role name is stored, so re-ranking or
 * inserting a role later is a code change, not a data migration.
 */
export const STUDY_ROLE_RANK: Readonly<Record<StudyRole, number>> = {
  VIEWER: 0,
  ANALYST: 1,
  EDITOR: 2,
  OWNER: 3,
};

/**
 * The minimum role each permission requires.
 *
 * Read this as the single source of truth for researcher authorization. A
 * controller never compares role strings; it declares a permission and the
 * guard consults this table.
 *
 * Two entries deserve their reasoning in writing:
 *
 * `analytics:view` is VIEWER, not ANALYST. REQUIREMENTS.md §5.2 defines VIEWER
 * as "view aggregate monitoring only; no response-level access" — aggregate
 * monitoring is precisely what the compliance dashboard shows (FR-27, FR-28).
 * The line that VIEWER must not cross is `response:view` and `export:run`,
 * which are individual psychological answers, and those are ANALYST.
 *
 * `study:lifecycle` is OWNER, not EDITOR. Closing a study stops data
 * collection for every enrolled participant and cancels their pending
 * sessions. That is not an editing operation, and it is not reversible:
 * `CLOSED → ACTIVE` does not exist.
 */
export const PERMISSION_MINIMUM_ROLE: Readonly<Record<StudyPermission, StudyRole>> = {
  "study:view": "VIEWER",
  "participant:view": "VIEWER",
  "analytics:view": "VIEWER",

  "response:view": "ANALYST",
  "export:run": "ANALYST",

  "study:edit": "EDITOR",
  "questionnaire:edit": "EDITOR",
  "protocol:edit": "EDITOR",
  "consent:edit": "EDITOR",
  "participant:manage": "EDITOR",

  "study:lifecycle": "OWNER",
  "study:members:manage": "OWNER",
  "study:audit:read": "OWNER",
};

/**
 * May a holder of `role` exercise `permission` in the study that role belongs
 * to?
 *
 * This function answers nothing about WHICH study. The caller must already
 * have established that the role was read from a membership row for the study
 * being acted on — NFR-04 requires the study filter to be in the query itself,
 * not inferred from a path parameter that happened to be checked.
 */
export function can(role: StudyRole, permission: StudyPermission): boolean {
  return STUDY_ROLE_RANK[role] >= STUDY_ROLE_RANK[PERMISSION_MINIMUM_ROLE[permission]];
}

/** Every permission a role holds, for building a UI capability payload. */
export function permissionsFor(role: StudyRole): StudyPermission[] {
  return STUDY_PERMISSIONS.filter((permission) => can(role, permission));
}

/** True when `role` is at least `minimum` in the linear order. */
export function atLeast(role: StudyRole, minimum: StudyRole): boolean {
  return STUDY_ROLE_RANK[role] >= STUDY_ROLE_RANK[minimum];
}

/**
 * Roles ordered most-privileged first. Used where a user's effective role must
 * be picked deterministically; the database prevents duplicate memberships, so
 * this is a safety net rather than the primary mechanism.
 */
export function highestRole(roles: readonly StudyRole[]): StudyRole | null {
  let best: StudyRole | null = null;
  for (const role of roles) {
    if (best === null || STUDY_ROLE_RANK[role] > STUDY_ROLE_RANK[best]) best = role;
  }
  return best;
}

/** The four roles, most privileged first. Stable order for UI selects. */
export const STUDY_ROLES_BY_RANK: readonly StudyRole[] = [...STUDY_ROLES].sort(
  (a, b) => STUDY_ROLE_RANK[b] - STUDY_ROLE_RANK[a],
);
