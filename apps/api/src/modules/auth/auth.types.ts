import type { Request } from "express";
import type { ResearcherProfile, StudyRole } from "@lpr/contracts";

/**
 * What a guard attaches to the request.
 *
 * `studyAccess` is set ONLY by StudyPermissionGuard, from a membership row it
 * read for this exact study. Handlers read the role from here rather than
 * re-deriving it, so there is one place where "which role does this caller
 * hold in this study" is decided.
 */
export interface RequestAuth {
  sessionId: string;
  csrfTokenHash: string;
  user: ResearcherProfile;
}

export interface RequestStudyAccess {
  studyId: string;
  role: StudyRole;
}

export interface AuthenticatedRequest extends Request {
  auth?: RequestAuth;
  studyAccess?: RequestStudyAccess;
}
