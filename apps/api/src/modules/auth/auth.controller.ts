import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import {
  changePasswordRequestSchema,
  confirmPasswordResetSchema,
  loginRequestSchema,
  requestPasswordResetSchema,
  type ChangePasswordRequest,
  type ConfirmPasswordResetRequest,
  type CsrfTokenResponse,
  type LoginRequest,
  type LoginResponse,
  type RequestPasswordResetRequest,
  type ResearcherProfile,
} from "@lpr/contracts";
import { ClockService } from "../../common/core.module.js";
import { setCsrfCookie, setSessionCookie } from "../../common/cookies.js";
import { loadEnv, shouldUseSecureCookies } from "../../config/env.js";
import { ZodBodyPipe } from "../../common/zod-body.pipe.js";
import { AuthService } from "./auth.service.js";
import { readResearcherCsrfToken } from "./csrf-bootstrap.js";
import { PasswordResetService } from "./password-reset.service.js";
import { CurrentSession, CurrentUser } from "./decorators/current-user.decorator.js";
import { Public } from "./decorators/public.decorator.js";
import type { AuthenticatedRequest, RequestAuth } from "./auth.types.js";

@Controller("api/auth")
export class AuthController {
  private readonly env = loadEnv();

  constructor(
    private readonly auth: AuthService,
    private readonly passwordResets: PasswordResetService,
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
   * Restores the dashboard's non-secret double-submit proof from the API's
   * host-only cookie after a deploy, reload, or lost Web Storage entry.
   *
   * GETs normally need no CSRF check, so this endpoint performs a deliberately
   * narrower check of its own: only the exact researcher origin may read it,
   * and the cookie must still be the one paired with the resolved session.
   * The public participant sibling origin is explicitly not sufficient.
   */
  @Get("csrf")
  @Header("Cache-Control", "no-store")
  csrf(
    @CurrentSession() session: RequestAuth,
    @Req() request: AuthenticatedRequest,
  ): CsrfTokenResponse {
    return {
      csrfToken: readResearcherCsrfToken(
        request,
        this.env.RESEARCHER_ORIGIN,
        session.csrfTokenHash,
      ),
    };
  }

  /**
   * `POST /api/auth/logout`
   *
   * Revokes server-side before replying. The response deliberately does not
   * clear the shared host cookies: an older logout response can arrive after a
   * newer login in another dashboard tab, and an unconditional Set-Cookie
   * deletion would destroy that newer session. The revoked token remaining in
   * the cookie jar is inert, expires at its original deadline, and is replaced
   * by the next successful login.
   */
  @Post("logout")
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentSession() session: RequestAuth,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.auth.logout(session.sessionId, session.user, this.clock.now(), {
      ip: clientIp(request),
      userAgent: request.headers["user-agent"],
    });
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

  /**
   * `POST /api/auth/password-reset/request`
   *
   * Public, because a researcher who has forgotten their password has no
   * session by definition. The CSRF origin check still applies, so a
   * cross-site page cannot fire reset emails on a visitor's behalf.
   *
   * ── Why 202 and an empty body, always ─────────────────────────────────────
   * The answer is identical whether or not the address belongs to an account.
   * Anything else — a different status, a different message, a different
   * latency, a different rate-limit budget — turns this into an oracle for
   * which researchers exist at an institution. 202 is the honest code: the
   * request has been accepted, and whether anything was sent is deliberately
   * not disclosed.
   */
  @Public()
  @Post("password-reset/request")
  @HttpCode(HttpStatus.ACCEPTED)
  async requestPasswordReset(
    @Body(new ZodBodyPipe(requestPasswordResetSchema)) body: RequestPasswordResetRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.passwordResets.request(
      body.email,
      {
        ip: clientIp(request),
        userAgent: request.headers["user-agent"],
      },
      this.clock.now(),
    );
  }

  /**
   * `POST /api/auth/password-reset/confirm`
   *
   * Spends the token and sets the new password. Public for the same reason,
   * and deliberately does NOT log the researcher in afterwards: arriving from
   * an emailed link is not the same as proving you are the account holder at a
   * keyboard, and a reset that ends in a live session would make a stolen link
   * strictly more valuable. They sign in with the new password, which is also
   * the moment they find out whether it saved.
   */
  @Public()
  @Post("password-reset/confirm")
  @HttpCode(HttpStatus.OK)
  async confirmPasswordReset(
    @Body(new ZodBodyPipe(confirmPasswordResetSchema)) body: ConfirmPasswordResetRequest,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.passwordResets.confirm(
      body.token,
      body.newPassword,
      {
        ip: clientIp(request),
        userAgent: request.headers["user-agent"],
      },
      this.clock.now(),
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
