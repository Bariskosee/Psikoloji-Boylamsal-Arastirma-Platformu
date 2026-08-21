import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import {
  registerPushSubscriptionSchema,
  unregisterPushSubscriptionSchema,
  type CredentialContext,
  type PushConfigResponse,
  type PushSubscriptionListResponse,
  type PushSubscriptionSummary,
  type RegisterPushSubscriptionRequest,
  type UnregisterPushSubscriptionRequest,
} from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { ClockService } from "../../common/core.module.js";
import { ZodBodyPipe } from "../../common/zod-body.pipe.js";
import { isPushConfigured, loadEnv } from "../../config/env.js";
import { Public } from "../auth/decorators/public.decorator.js";
import { RateLimitService } from "../auth/rate-limit.service.js";
import {
  CurrentParticipant,
  ParticipantRoute,
} from "../participant/decorators/participant-route.decorator.js";
import { PushService } from "./push.service.js";

/**
 * Push subscription management (PLAN.md Phase 8, ADR-006, FR-16).
 *
 * Every route here is authenticated by the continuity cookie and derives the
 * participant from it. None takes a participant identifier, because a
 * participant identifier in a URL is never an authorization mechanism
 * (STRUCTURE.md §4) — and a push endpoint is a capability to wake someone's
 * phone, so "whose subscription is this?" must never be answerable by asking.
 *
 * **Nothing here sends.** Phase 8 stores subscriptions; Phase 9 uses them.
 */
@Controller("api/participant/push")
export class PushController {
  private readonly env = loadEnv();

  constructor(
    private readonly push: PushService,
    private readonly rateLimits: RateLimitService,
    private readonly clock: ClockService,
  ) {}

  /**
   * What the client needs before it can subscribe.
   *
   * The PUBLIC key only. The private half never leaves this process and is not
   * reachable from any route — that is the whole of ADR-006's secret handling,
   * and there is an integration test asserting this response cannot be made to
   * contain it.
   *
   * `null` rather than an error when the deployment has no keys: the client's
   * correct response is to stop offering notifications and say the study is
   * running without them, which it cannot do if this call fails.
   */
  @ParticipantRoute()
  @Public()
  @Get("config")
  config(): PushConfigResponse {
    return {
      vapidPublicKey: isPushConfigured(this.env) ? this.env.VAPID_PUBLIC_KEY : null,
    };
  }

  /**
   * Register or refresh this device's subscription.
   *
   * Rate limited per participant rather than per IP (STRUCTURE.md §11.5). A
   * cohort behind one university NAT shares an address, and an IP budget would
   * make one enthusiastic participant silence the rest.
   */
  @ParticipantRoute()
  @Public()
  @Post("subscriptions")
  @HttpCode(HttpStatus.CREATED)
  async register(
    @CurrentParticipant()
    participant: { id: string; status: string; credentialContext: CredentialContext },
    @Body(new ZodBodyPipe(registerPushSubscriptionSchema)) body: RegisterPushSubscriptionRequest,
  ): Promise<PushSubscriptionSummary> {
    if (participant.status === "WITHDRAWN") throw ApiErrors.participantWithdrawn();

    // Refused rather than stored. Accepting a subscription this deployment can
    // never send to would leave the participant a settings screen saying
    // notifications are on, and no notifications — the failure mode ADR-006
    // asks us to make impossible rather than merely unlikely.
    if (!isPushConfigured(this.env)) throw ApiErrors.pushNotConfigured();

    this.limit(`push-register:${participant.id}`, this.env.PUSH_RATE_LIMIT_MAX);

    return this.push.register(
      participant.id,
      body,
      participant.credentialContext,
      this.clock.now(),
    );
  }

  /** The devices currently registered, for the notifications settings screen. */
  @ParticipantRoute()
  @Public()
  @Get("subscriptions")
  async list(
    @CurrentParticipant() participant: { id: string },
  ): Promise<PushSubscriptionListResponse> {
    return { subscriptions: await this.push.listActive(participant.id) };
  }

  /**
   * Turn notifications off for one device.
   *
   * 204 whether or not a row was found. The endpoint arrives from the client,
   * and answering 404 for one that is not ours would confirm to a caller
   * holding an endpoint whether it belongs to somebody in this study — the same
   * enumeration reasoning that governs recovery codes. Unsubscribing is
   * idempotent from the participant's point of view either way.
   */
  @ParticipantRoute()
  @Public()
  @Delete("subscriptions")
  @HttpCode(HttpStatus.NO_CONTENT)
  async unregister(
    @CurrentParticipant() participant: { id: string },
    @Body(new ZodBodyPipe(unregisterPushSubscriptionSchema))
    body: UnregisterPushSubscriptionRequest,
  ): Promise<void> {
    await this.push.deactivateEndpoint(
      participant.id,
      body.endpoint,
      "UNSUBSCRIBED",
      this.clock.now(),
    );
  }

  private limit(key: string, perHour: number): void {
    const decision = this.rateLimits.hit(key, perHour, 60 * 60 * 1000, this.clock.now().getTime());
    if (!decision.allowed) throw ApiErrors.rateLimited(decision.retryAfterSeconds);
  }
}
