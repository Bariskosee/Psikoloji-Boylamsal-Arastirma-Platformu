import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Put, Req } from "@nestjs/common";
import {
  upsertConsentTranslationSchema,
  type ConsentVersionListResponse,
  type ConsentVersionResponse,
  type ResearcherProfile,
  type UpsertConsentTranslationRequest,
} from "@lpr/contracts";
import { ClockService } from "../../common/core.module.js";
import { ZodBodyPipe } from "../../common/zod-body.pipe.js";
import { CurrentUser, StudyAccess } from "../auth/decorators/current-user.decorator.js";
import { RequireStudyPermission } from "../auth/decorators/require-study-permission.decorator.js";
import type { AuthenticatedRequest, RequestStudyAccess } from "../auth/auth.types.js";
import { ConsentService } from "./consent.service.js";

/**
 * `/api/studies/:studyId/consent/**` (PLAN.md Phase 5).
 *
 * EDITOR, like the other builder surfaces. Consent text is study configuration,
 * not participant data.
 */
@Controller("api/studies/:studyId/consent")
export class ConsentController {
  constructor(
    private readonly consent: ConsentService,
    private readonly clock: ClockService,
  ) {}

  @Get()
  @RequireStudyPermission("consent:edit")
  async list(
    @Param("studyId") _studyId: string,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<ConsentVersionListResponse> {
    return this.consent.list(access.studyId);
  }

  @Get("draft")
  @RequireStudyPermission("consent:edit")
  async draft(
    @Param("studyId") _studyId: string,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<ConsentVersionResponse> {
    return this.consent.draft(access.studyId, this.clock.now());
  }

  @Put("draft/translations")
  @RequireStudyPermission("consent:edit")
  async upsertTranslation(
    @Param("studyId") _studyId: string,
    @Body(new ZodBodyPipe(upsertConsentTranslationSchema)) body: UpsertConsentTranslationRequest,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<ConsentVersionResponse> {
    return this.consent.upsertTranslation(access.studyId, body, this.clock.now());
  }

  @Post("publish")
  @HttpCode(HttpStatus.CREATED)
  @RequireStudyPermission("consent:edit")
  async publish(
    @Param("studyId") _studyId: string,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<ConsentVersionResponse> {
    return this.consent.publish(user, access.studyId, this.clock.now(), {
      ip: request.ip,
      userAgent: request.headers["user-agent"],
    });
  }
}
