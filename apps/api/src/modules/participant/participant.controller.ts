import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import {
  PARTICIPANT_COOKIE_MAX_AGE_MS,
  enrollRequestSchema,
  handoffRedeemRequestSchema,
  localeSchema,
  recoverRequestSchema,
  updateParticipantSchema,
  withdrawRequestSchema,
  type EnrollRequest,
  type EnrollResponse,
  type HandoffMintResponse,
  type HandoffRedeemRequest,
  type Locale,
  type ParticipantMeResponse,
  type PublicStudyResponse,
  type RecoverRequest,
  type UpdateParticipantRequest,
  type WithdrawRequest,
} from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { ClockService } from "../../common/core.module.js";
import { clearParticipantCookie, setParticipantCookie } from "../../common/cookies.js";
import { ZodBodyPipe } from "../../common/zod-body.pipe.js";
import { loadEnv, shouldUseSecureCookies } from "../../config/env.js";
import { Public } from "../auth/decorators/public.decorator.js";
import { RateLimitService } from "../auth/rate-limit.service.js";
import { CurrentParticipant, ParticipantRoute } from "./decorators/participant-route.decorator.js";
import { ContinuityService } from "./continuity.service.js";
import { ParticipantService } from "./participant.service.js";
import type { ParticipantRequest } from "./guards/participant-auth.guard.js";

/**
 * The participant-facing API (PLAN.md Phase 5).
 *
 * Three public routes reachable with only a study code, and three that need
 * the continuity cookie. No researcher session is involved anywhere.
 *
 * ── Uniformity ──────────────────────────────────────────────────────────────
 * Rate limits are applied BEFORE the lookup and identically for a valid and an
 * invalid code, so neither the response nor the amount of work done reveals
 * whether a code exists. That is the enumeration defence the acceptance
 * criteria test for.
 */
@Controller("api/participant")
export class ParticipantController {
  private readonly env = loadEnv();

  constructor(
    private readonly participants: ParticipantService,
    private readonly continuity: ContinuityService,
    private readonly rateLimits: RateLimitService,
    private readonly clock: ClockService,
  ) {}

  private cookieSettings() {
    return {
      secure: shouldUseSecureCookies(this.env),
      maxAgeMs: PARTICIPANT_COOKIE_MAX_AGE_MS,
    };
  }

  /** The study behind an enrollment link, before consenting. */
  @Public()
  @Get("studies/:code")
  async publicStudy(
    @Param("code") code: string,
    @Query("locale") locale: string | undefined,
    @Req() request: ParticipantRequest,
  ): Promise<PublicStudyResponse> {
    this.limit(`public-study:${clientKey(request)}`, 60);

    const parsed = localeSchema.safeParse(locale);
    return this.participants.publicStudy(code, parsed.success ? parsed.data : ("en" as Locale));
  }

  /**
   * Enroll and receive an identity.
   *
   * The continuity token goes out as an HttpOnly cookie and appears nowhere in
   * the body. The recovery code is in the body because this is the only moment
   * it can be — it is stored hashed, so it genuinely cannot be shown again.
   */
  @Public()
  @Post("studies/:code/enroll")
  @HttpCode(HttpStatus.CREATED)
  async enroll(
    @Param("code") code: string,
    @Body(new ZodBodyPipe(enrollRequestSchema)) body: EnrollRequest,
    @Req() request: ParticipantRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<EnrollResponse> {
    this.limit(`enroll:${clientKey(request)}`, 10);

    const result = await this.participants.enroll(code, body, this.clock.now());

    setParticipantCookie(response, result.token, this.cookieSettings());

    return {
      publicCode: result.publicCode,
      recoveryCode: result.recoveryCode,
      locale: result.locale,
    };
  }

  /**
   * Redeem a recovery code for a new credential.
   *
   * Rate limited hard: eight characters is guessable at scale, and the limiter
   * is what turns "guessable" into "not worth attempting". A wrong code and an
   * unknown code produce the same error.
   */
  @Public()
  @Post("recover")
  @HttpCode(HttpStatus.OK)
  async recover(
    @Body(new ZodBodyPipe(recoverRequestSchema)) body: RecoverRequest,
    @Req() request: ParticipantRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ ok: true }> {
    this.limit(`recover:${clientKey(request)}`, 5);

    const now = this.clock.now();
    const participantId = await this.continuity.redeemRecoveryCode(body.recoveryCode, now);
    if (participantId === null) throw ApiErrors.participantAuthRequired();

    const minted = await this.continuity.issueAfterRecovery(participantId, now);
    setParticipantCookie(response, minted.token, this.cookieSettings());

    return { ok: true };
  }

  @ParticipantRoute()
  @Public()
  @Get("me")
  async me(@CurrentParticipant() participant: { id: string }): Promise<ParticipantMeResponse> {
    return this.participants.me(participant.id);
  }

  @ParticipantRoute()
  @Public()
  @Patch("me")
  async update(
    @CurrentParticipant() participant: { id: string; status: string },
    @Body(new ZodBodyPipe(updateParticipantSchema)) body: UpdateParticipantRequest,
  ): Promise<ParticipantMeResponse> {
    if (participant.status === "WITHDRAWN") throw ApiErrors.participantWithdrawn();
    return this.participants.update(participant.id, body, this.clock.now());
  }

  /**
   * Mint a one-time install handoff code (STRUCTURE.md §11.4, ADR-007, FR-41).
   *
   * Authenticated, so it can only ever be minted by the participant whose
   * identity it will carry. The code goes in the body — the one secret in this
   * controller that does, because its entire purpose is to be rendered as a
   * tappable link in the Safari tab the participant is looking at.
   *
   * Rate limited despite being authenticated. An unbounded mint would let one
   * device fill the table with live capabilities, and each of them is a
   * 24-hour key to that participant's identity.
   */
  @ParticipantRoute()
  @Public()
  @Post("handoff")
  @HttpCode(HttpStatus.CREATED)
  async mintHandoff(
    @CurrentParticipant() participant: { id: string; status: string },
    @Req() request: ParticipantRequest,
  ): Promise<HandoffMintResponse> {
    if (participant.status === "WITHDRAWN") throw ApiErrors.participantWithdrawn();
    this.limit(`handoff-mint:${clientKey(request)}`, 20);

    const minted = await this.continuity.mintHandoffCode(participant.id, this.clock.now());
    return { code: minted.code, expiresAt: minted.expiresAt.toISOString() };
  }

  /**
   * Redeem an install handoff code inside the newly installed application.
   *
   * Public, because the whole point is that the caller has no credential yet:
   * on iOS the installed application opens with an empty cookie store, and
   * this is the request that gives it one bound to the SAME participant
   * (STRUCTURE.md §11.4).
   *
   * Rate limited hard for the same reason recovery is. Expired, already
   * redeemed and never-existed are answered identically — the reason is
   * recorded for the operator and never returned, because telling them apart
   * confirms that a code someone holds once existed.
   */
  @Public()
  @Post("handoff/redeem")
  @HttpCode(HttpStatus.OK)
  async redeemHandoff(
    @Body(new ZodBodyPipe(handoffRedeemRequestSchema)) body: HandoffRedeemRequest,
    @Req() request: ParticipantRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ ok: true }> {
    this.limit(`handoff-redeem:${clientKey(request)}`, 10);

    const now = this.clock.now();
    const redeemed = await this.continuity.redeemHandoffCode(body.code, now);
    if (!redeemed.ok) throw ApiErrors.handoffCodeInvalid();

    const minted = await this.continuity.issueAfterHandoff(redeemed.participantId, now);
    setParticipantCookie(response, minted.token, this.cookieSettings());

    return { ok: true };
  }

  @ParticipantRoute()
  @Public()
  @Post("withdraw")
  @HttpCode(HttpStatus.NO_CONTENT)
  async withdraw(
    @CurrentParticipant() participant: { id: string },
    @Body(new ZodBodyPipe(withdrawRequestSchema)) body: WithdrawRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.participants.withdraw(participant.id, body.reason, this.clock.now());

    // Clear the cookie too. The credential is revoked server-side either way;
    // leaving a dead cookie behind would make the next visit look like a
    // failure rather than a clean exit.
    clearParticipantCookie(response, { ...this.cookieSettings(), maxAgeMs: 0 });
  }

  private limit(key: string, perHour: number): void {
    const decision = this.rateLimits.hit(key, perHour, 60 * 60 * 1000, this.clock.now().getTime());
    if (!decision.allowed) throw ApiErrors.rateLimited(decision.retryAfterSeconds);
  }
}

/**
 * The rate-limit bucket for an unauthenticated caller.
 *
 * IP only. There is nothing else to key on before enrollment, and keying on
 * anything the caller supplies would let them reset their own limit.
 */
function clientKey(request: ParticipantRequest): string {
  return request.ip ?? "unknown";
}
