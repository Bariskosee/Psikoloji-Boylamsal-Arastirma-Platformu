import { ExecutionContext, createParamDecorator } from "@nestjs/common";
import type { ResearcherProfile } from "@lpr/contracts";
import { ApiErrors } from "../../../common/api-error.js";
import type { AuthenticatedRequest, RequestAuth, RequestStudyAccess } from "../auth.types.js";

/** The authenticated researcher. Throws rather than returning undefined. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ResearcherProfile => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.auth) throw ApiErrors.authenticationRequired();
    return request.auth.user;
  },
);

/** The full session context, for handlers that need the session id. */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestAuth => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.auth) throw ApiErrors.authenticationRequired();
    return request.auth;
  },
);

/**
 * The caller's verified access to the study in the path.
 *
 * Only present when StudyPermissionGuard ran, so a handler cannot read a role
 * that nothing checked.
 */
export const StudyAccess = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestStudyAccess => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.studyAccess) {
      // A programming error, not a client error: the handler asked for study
      // access without declaring the permission that establishes it.
      throw ApiErrors.forbidden("Study access was not established for this route");
    }
    return request.studyAccess;
  },
);
