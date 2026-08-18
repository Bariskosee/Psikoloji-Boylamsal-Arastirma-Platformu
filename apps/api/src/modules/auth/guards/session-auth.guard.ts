import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { SESSION_COOKIE_NAME } from "@lpr/contracts";
import { ApiErrors } from "../../../common/api-error.js";
import { ClockService } from "../../../common/core.module.js";
import { readCookie } from "../../../common/cookies.js";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator.js";
import { SessionService } from "../session.service.js";
import type { AuthenticatedRequest } from "../auth.types.js";

/**
 * Resolves the session cookie on every request.
 *
 * Registered globally, so authentication is the default and `@Public()` is the
 * exception. The inverse — protecting routes one decorator at a time — fails
 * open: the day someone adds a controller and forgets, participant or response
 * data is served to anyone.
 */
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
    private readonly clock: ClockService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const token = readCookie(request.cookies, SESSION_COOKIE_NAME);

    /**
     * A public route still resolves a session when one is present, because
     * `POST /api/auth/login` needs to know whether it is replacing an existing
     * session, and audit rows on public routes should be attributed when they
     * can be. It just does not REQUIRE one.
     */
    if (token) {
      const session = await this.sessions.resolve(token, this.clock.now());
      if (session) {
        request.auth = {
          sessionId: session.sessionId,
          csrfTokenHash: session.csrfTokenHash,
          user: session.user,
        };
      } else if (!isPublic) {
        // A cookie that no longer resolves is expired or revoked — a distinct
        // code from "you never authenticated", so the dashboard can redirect
        // to login with an explanation rather than looking broken.
        throw ApiErrors.sessionExpired();
      }
    }

    if (isPublic) return true;
    if (!request.auth) throw ApiErrors.authenticationRequired();
    return true;
  }
}
