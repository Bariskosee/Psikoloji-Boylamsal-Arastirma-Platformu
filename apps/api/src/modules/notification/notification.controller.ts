import { Body, Controller, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import {
  reportNotificationEventSchema,
  type NotificationHistoryResponse,
  type ReportNotificationEventRequest,
} from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { ClockService } from "../../common/core.module.js";
import { ZodBodyPipe } from "../../common/zod-body.pipe.js";
import { Public } from "../auth/decorators/public.decorator.js";
import { RateLimitService } from "../auth/rate-limit.service.js";
import {
  CurrentParticipant,
  ParticipantRoute,
} from "../participant/decorators/participant-route.decorator.js";
import { NotificationService } from "./notification.service.js";

/**
 * Notification reporting and history (PLAN.md Phase 9, FR-19).
 *
 * **Nothing here sends.** The worker owns sending, because it owns the VAPID
 * private key and because a reminder must not depend on an API instance
 * happening to be awake. These two routes are the participant's side of the
 * record: what their device managed to tell us, and what we sent them.
 */
@Controller("api/participant/notifications")
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly rateLimits: RateLimitService,
    private readonly clock: ClockService,
  ) {}

  /**
   * A best-effort client report (STRUCTURE.md §9.3).
   *
   * Rate limited per participant despite being authenticated: the service
   * worker fires these unattended, and a client bug that reported in a loop
   * would otherwise write to the notification record as fast as it could.
   */
  @ParticipantRoute()
  @Public()
  @Post("events")
  @HttpCode(HttpStatus.NO_CONTENT)
  async report(
    @CurrentParticipant() participant: { id: string },
    @Body(new ZodBodyPipe(reportNotificationEventSchema)) body: ReportNotificationEventRequest,
  ): Promise<void> {
    this.limit(`notification-event:${participant.id}`, 300);
    await this.notifications.recordClientEvent(participant.id, body, this.clock.now());
  }

  /** What this study has sent this participant, newest first. */
  @ParticipantRoute()
  @Public()
  @Get()
  async history(
    @CurrentParticipant() participant: { id: string },
  ): Promise<NotificationHistoryResponse> {
    return { attempts: await this.notifications.history(participant.id) };
  }

  private limit(key: string, perHour: number): void {
    const decision = this.rateLimits.hit(key, perHour, 60 * 60 * 1000, this.clock.now().getTime());
    if (!decision.allowed) throw ApiErrors.rateLimited(decision.retryAfterSeconds);
  }
}
