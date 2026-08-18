import { SetMetadata } from "@nestjs/common";
import type { StudyPermission } from "@lpr/contracts";

export const STUDY_PERMISSION_KEY = "lpr:studyPermission";

/**
 * Declares the permission a route requires in the study named by its path.
 *
 * A controller never compares role strings. It names a permission; the guard
 * reads the membership row for this study and asks @lpr/domain whether the
 * role satisfies it. That indirection is what keeps the authorization rules in
 * one exhaustively tested table instead of scattered across handlers.
 */
export const RequireStudyPermission = (permission: StudyPermission) =>
  SetMetadata(STUDY_PERMISSION_KEY, permission);
