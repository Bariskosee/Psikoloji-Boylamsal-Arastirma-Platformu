import { Controller, Get, Param, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import type {
  DailyComplianceResponse,
  DistributionsResponse,
  OperationsHealthResponse,
  ParticipantDetailResponse,
  ParticipantListResponse,
  SessionInspectionResponse,
  StudyOverviewResponse,
} from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { uuidParam } from "../../common/uuid-param.pipe.js";
import { AdminGuard } from "../auth/guards/admin.guard.js";
import { CurrentUser } from "../auth/decorators/current-user.decorator.js";
import { RequireStudyPermission } from "../auth/decorators/require-study-permission.decorator.js";
import { ClockService } from "../../common/core.module.js";
import { AuditService } from "../audit/audit.service.js";
import { AnalyticsService } from "./analytics.service.js";
import { InspectorService } from "./inspector.service.js";
import { OperationsService } from "./operations.service.js";

/**
 * Monitoring and compliance (PLAN.md Phase 10).
 *
 * ── The permission line, and where it falls ─────────────────────────────────
 * Overview, daily breakdown, the participant list and a participant's timeline
 * are `analytics:view` — VIEWER. REQUIREMENTS.md §5.2 defines VIEWER as
 * "aggregate monitoring only", and a timeline of states is exactly that: it
 * says whether someone completed a session, never what they answered.
 *
 * The response inspector is `response:view` — ANALYST. That is the line VIEWER
 * must not cross, because it is the one screen showing individual
 * psychological answers. It is also the only one here that is AUDITED: reading
 * a person's responses is an act worth a record, and aggregate monitoring is
 * not (NFR-05).
 */
@Controller("api/studies/:studyId")
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly inspector: InspectorService,
    private readonly audit: AuditService,
    private readonly clock: ClockService,
  ) {}

  @Get("analytics/overview")
  @RequireStudyPermission("analytics:view")
  async overview(@Param("studyId") studyId: string): Promise<StudyOverviewResponse> {
    return this.analytics.overview(studyId);
  }

  @Get("analytics/distributions")
  @RequireStudyPermission("analytics:view")
  async distributions(@Param("studyId") studyId: string): Promise<DistributionsResponse> {
    return this.analytics.distributions(studyId);
  }

  @Get("analytics/daily")
  @RequireStudyPermission("analytics:view")
  async daily(
    @Param("studyId") studyId: string,
    @Query("days") days?: string,
  ): Promise<DailyComplianceResponse> {
    return this.analytics.daily(studyId, days === undefined ? undefined : Number(days));
  }

  @Get("participants")
  @RequireStudyPermission("participant:view")
  async participants(
    @Param("studyId") studyId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ): Promise<ParticipantListResponse> {
    return this.analytics.participants(studyId, {
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit: Number(limit) }),
    });
  }

  @Get("participants/:participantId")
  @RequireStudyPermission("participant:view")
  async participant(
    @Param("studyId") studyId: string,
    @Param("participantId", uuidParam(() => ApiErrors.participantNotFound()))
    participantId: string,
  ): Promise<ParticipantDetailResponse> {
    return this.analytics.participantDetail(studyId, participantId);
  }

  /**
   * Individual responses. ANALYST and above, and audited.
   *
   * The audit row is written AFTER the read succeeds, so a 404 for a session in
   * another study does not leave a record implying the data was seen. It names
   * the session rather than the answers: an audit trail must not become a
   * second copy of the psychological data it is protecting.
   */
  @Get("sessions/:sessionId/responses")
  @RequireStudyPermission("response:view")
  async inspect(
    @Param("studyId") studyId: string,
    @Param("sessionId", uuidParam(() => ApiErrors.sessionNotFound())) sessionId: string,
    @CurrentUser() user: { id: string; email: string },
    @Req() request: Request,
  ): Promise<SessionInspectionResponse> {
    const inspection = await this.inspector.inspect(studyId, sessionId);

    await this.audit.record({
      actorType: "RESEARCHER",
      actorId: user.id,
      actorLabel: user.email,
      studyId,
      action: "response.view",
      entityType: "participant_session",
      entityId: sessionId,
      // The COUNT, never the answers. An audit trail must not become a second
      // copy of the psychological data it exists to protect.
      metadata: { answerCount: inspection.answers.length },
      context: { ip: request.ip, userAgent: request.headers["user-agent"] },
      occurredAt: this.clock.now(),
    });

    return inspection;
  }
}

/**
 * Operational health, admin only (ADR-004, ADR-005, ADR-010).
 *
 * Its own controller because it is not study-scoped: sweeper liveness and the
 * dead-letter queue are properties of the deployment, not of any one study, and
 * hanging them off `/api/studies/:id` would imply an ownership that does not
 * exist. Admin rather than a study role for the same reason — a study OWNER has
 * no business reading another study's notification failure rates.
 *
 * The guard sits on the CONTROLLER, not on the method. Phase 12's authorization
 * review found the check written inline in the handler: correct, and tested,
 * but per-method — a second ops route added here would have silently inherited
 * nothing. At the controller it is inherited by construction.
 */
@Controller("api/ops")
@UseGuards(AdminGuard)
export class OperationsController {
  constructor(private readonly operations: OperationsService) {}

  @Get("health")
  async health(
    @CurrentUser() user: { id: string; isAdmin: boolean },
  ): Promise<OperationsHealthResponse> {
    // Admin, not a study role. Nothing here belongs to a study, so there is no
    // membership to check against — and a study OWNER has no business reading
    // another study's notification failure rates.
    if (!user.isAdmin) throw ApiErrors.forbidden();
    return this.operations.health();
  }
}
