import { z } from "zod";

/**
 * Study-scoped researcher roles (REQUIREMENTS.md §5.2).
 *
 * Exactly four roles in the MVP. They are scoped PER STUDY: a user may be an
 * OWNER of one study and a VIEWER of another, and holding a role in one study
 * grants nothing in any other. A finer-grained permission matrix is explicitly
 * out of MVP scope.
 *
 * The order is significant — see `STUDY_ROLE_RANK` in @lpr/domain. Anything
 * that needs to reason about "at least ANALYST" uses that rank, never a string
 * comparison here.
 */
export const STUDY_ROLES = ["OWNER", "EDITOR", "ANALYST", "VIEWER"] as const;

export const studyRoleSchema = z.enum(STUDY_ROLES);
export type StudyRole = z.infer<typeof studyRoleSchema>;

/**
 * Permissions checked by the server.
 *
 * This list covers the whole MVP surface, not only Phase 2, because the
 * authorization model established in Phase 2 is what every later phase
 * inherits (PLAN.md Phase 2). Adding an endpoint later means picking an
 * existing permission, not inventing an ad-hoc role check at the controller.
 *
 * The permission is the unit of authorization. A controller never asks
 * "is this user an OWNER"; it asks "may this user manage members".
 */
export const STUDY_PERMISSIONS = [
  // Study configuration
  "study:view",
  "study:edit",
  "study:lifecycle",
  "study:members:manage",
  "study:audit:read",

  // Content building (Phases 3–4)
  "questionnaire:edit",
  "protocol:edit",
  "consent:edit",

  // Participant operations (Phases 5–7)
  "participant:view",
  "participant:manage",

  // Data access (Phases 10–11)
  "response:view",
  "analytics:view",
  "export:run",
] as const;

export const studyPermissionSchema = z.enum(STUDY_PERMISSIONS);
export type StudyPermission = z.infer<typeof studyPermissionSchema>;
