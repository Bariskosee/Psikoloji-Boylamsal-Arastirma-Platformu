import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from "@nestjs/common";
import type { Response } from "express";
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  type ChangePasswordRequest,
  type LoginRequest,
  type LoginResponse,
  type ResearcherProfile,
} from "@lpr/contracts";
import { ClockService } from "../../common/core.module.js";
import { clearAuthCookies, setCsrfCookie, setSessionCookie } from "../../common/cookies.js";
import { loadEnv, shouldUseSecureCookies } from "../../config/env.js";
import { ZodBodyPipe } from "../../common/zod-body.pipe.js";
import { AuthService } from "./auth.service.js";
import { CurrentSession, CurrentUser } from "./decorators/current-user.decorator.js";
import { Public } from "./decorators/public.decorator.js";
import type { AuthenticatedRequest, RequestAuth } from "./auth.types.js";

@Controller("api/auth")
export class AuthController {
  private readonly env = loadEnv();

  constructor(
    private readonly auth: AuthService,
    private readonly clock: ClockService,
  ) {}

  /**
   * `POST /api/auth/login`
   *
   * Public because there is no session yet — but the CSRF origin check still
   * applies to it (see CsrfGuard), so a cross-site page cannot log a victim
   * into an account of the attacker's choosing.
   */
  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body(new ZodBodyPipe(loginRequestSchema)) body: LoginRequest,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoginResponse> {
    const now = this.clock.now();
    const context = { ip: clientIp(request), userAgent: request.headers["user-agent"] };

    // Any existing session is revoked before a new one is issued, so logging
    // in as a second account cannot leave the first one alive on the same
    // browser — and so a fixated session can never survive authentication.
    if (request.auth)
      await this.auth.logout(request.auth.sessionId, request.auth.user, now, context);

    const { profile, session } = await this.auth.login(body.email, body.password, now, context);

    const cookieSettings = {
      secure: shouldUseSecureCookies(this.env),
      maxAgeMs: session.expiresAt.getTime() - now.getTime(),
    };
    setSessionCookie(response, session.sessionToken, cookieSettings);
    setCsrfCookie(response, session.csrfToken, cookieSettings);

    return { user: profile, csrfToken: session.csrfToken };
  }

  /** `GET /api/auth/me` — who am I, and is this session still valid? */
  @Get("me")
  me(@CurrentUser() user: ResearcherProfile): { user: ResearcherProfile } {
    return { user };
  }

  /**
   * `POST /api/auth/logout`
   *
   * Revokes server-side FIRST, then clears the cookies. If the response never
   * reaches the browser, the session is still dead — the opposite order would
   * leave a live session behind on a dropped connection.
   */
  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentSession() session: RequestAuth,
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.auth.logout(session.sessionId, session.user, this.clock.now(), {
      ip: clientIp(request),
      userAgent: request.headers["user-agent"],
    });
    clearAuthCookies(response, { secure: shouldUseSecureCookies(this.env), maxAgeMs: 0 });
  }

  /**
   * `POST /api/auth/password`
   *
   * Ends every other session the account holds. A password change made because
   * "someone may have my session" is worthless if the stolen session survives.
   */
  @Post("password")
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @Body(new ZodBodyPipe(changePasswordRequestSchema)) body: ChangePasswordRequest,
    @CurrentSession() session: RequestAuth,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ revokedSessions: number }> {
    return this.auth.changePassword(
      session.user,
      session.sessionId,
      body.currentPassword,
      body.newPassword,
      this.clock.now(),
      { ip: clientIp(request), userAgent: request.headers["user-agent"] },
    );
  }
}

/**
 * The client address, as far as it can be trusted.
 *
 * Express only populates `req.ip` from `X-Forwarded-For` when `trust proxy` is
 * set, which main.ts does for the single known proxy in front of the service.
 * Without that, a client could set the header itself and hand the rate limiter
 * a fresh budget on every request.
 */
function clientIp(request: AuthenticatedRequest): string | undefined {
  return request.ip;
}
