import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { ApiErrors } from "../../../common/api-error.js";
import type { AuthenticatedRequest } from "../auth.types.js";

/**
 * Platform administration, not study membership (Phase 12).
 *
 * Applied to a whole controller rather than to each method, which is the point:
 * the operations page's admin check used to live inline in its one handler, so
 * a second route added beside it would have inherited nothing and served
 * deployment health to any authenticated researcher. At the controller the
 * restriction is inherited by construction.
 *
 * Runs AFTER the global session guard, so `request.auth` is already resolved.
 * An unauthenticated caller never reaches here.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!request.auth) throw ApiErrors.authenticationRequired();
    if (!request.auth.user.isAdmin) throw ApiErrors.forbidden();
    return true;
  }
}
