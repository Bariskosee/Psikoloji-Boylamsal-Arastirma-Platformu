import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import {
  createProtocolSchema,
  previewProtocolSchema,
  protocolStepInputSchema,
  reorderProtocolStepsSchema,
  updateProtocolSchema,
  updateProtocolStepSchema,
  type CreateProtocolRequest,
  type PreviewProtocolRequest,
  type ProtocolDetail,
  type ProtocolListResponse,
  type ProtocolPreviewResponse,
  type ProtocolStepInput,
  type ProtocolStepResponse,
  type ProtocolVersionDetail,
  type ReorderProtocolStepsRequest,
  type ResearcherProfile,
  type UpdateProtocolRequest,
  type UpdateProtocolStepRequest,
} from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { ClockService } from "../../common/core.module.js";
import { uuidParam } from "../../common/uuid-param.pipe.js";
import { ZodBodyPipe } from "../../common/zod-body.pipe.js";
import { CurrentUser, StudyAccess } from "../auth/decorators/current-user.decorator.js";
import { RequireStudyPermission } from "../auth/decorators/require-study-permission.decorator.js";
import type { AuthenticatedRequest, RequestStudyAccess } from "../auth/auth.types.js";
import { ProtocolStepService } from "./protocol-step.service.js";
import { ProtocolService } from "./protocol.service.js";

/**
 * `/api/studies/:studyId/protocols/**` (PLAN.md Phase 4).
 *
 * Every route requires `protocol:edit` (EDITOR), matching the questionnaire
 * module: a protocol is builder surface, and a VIEWER's remit is aggregate
 * monitoring, which the analytics endpoints serve.
 *
 * As in the questionnaire module, no route accepts a version id for a WRITE.
 * Step mutations resolve the protocol's current draft server-side, which makes
 * "edit a published version" unrepresentable in the URL space rather than
 * merely rejected (AGENT.md §17). The one place a version id is accepted is
 * the read and the preview, where naming a published version is the point.
 */
@Controller("api/studies/:studyId/protocols")
export class ProtocolController {
  constructor(
    private readonly protocols: ProtocolService,
    private readonly steps: ProtocolStepService,
    private readonly clock: ClockService,
  ) {}

  @Get()
  @RequireStudyPermission("protocol:edit")
  async list(
    @Param("studyId") _studyId: string,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<ProtocolListResponse> {
    return { protocols: await this.protocols.list(access.studyId) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireStudyPermission("protocol:edit")
  async create(
    @Param("studyId") _studyId: string,
    @Body(new ZodBodyPipe(createProtocolSchema)) body: CreateProtocolRequest,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProtocolDetail> {
    return this.protocols.create(user, access.studyId, body, this.clock.now(), context(request));
  }

  @Get(":protocolId")
  @RequireStudyPermission("protocol:edit")
  async get(
    @Param("studyId") _studyId: string,
    @Param("protocolId", uuidParam(ApiErrors.protocolNotFound)) protocolId: string,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<ProtocolDetail> {
    return this.protocols.get(access.studyId, protocolId);
  }

  @Patch(":protocolId")
  @RequireStudyPermission("protocol:edit")
  async update(
    @Param("studyId") _studyId: string,
    @Param("protocolId", uuidParam(ApiErrors.protocolNotFound)) protocolId: string,
    @Body(new ZodBodyPipe(updateProtocolSchema)) body: UpdateProtocolRequest,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProtocolDetail> {
    return this.protocols.update(
      user,
      access.studyId,
      protocolId,
      body,
      this.clock.now(),
      context(request),
    );
  }

  @Get(":protocolId/versions/:versionId")
  @RequireStudyPermission("protocol:edit")
  async getVersion(
    @Param("studyId") _studyId: string,
    @Param("protocolId", uuidParam(ApiErrors.protocolNotFound)) protocolId: string,
    @Param("versionId", uuidParam(ApiErrors.protocolNotFound)) versionId: string,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<ProtocolVersionDetail> {
    return this.protocols.getVersion(access.studyId, protocolId, versionId);
  }

  @Post(":protocolId/publish")
  @HttpCode(HttpStatus.CREATED)
  @RequireStudyPermission("protocol:edit")
  async publish(
    @Param("studyId") _studyId: string,
    @Param("protocolId", uuidParam(ApiErrors.protocolNotFound)) protocolId: string,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProtocolVersionDetail> {
    return this.protocols.publish(
      user,
      access.studyId,
      protocolId,
      this.clock.now(),
      context(request),
    );
  }

  /**
   * The timeline preview.
   *
   * A POST because it takes a body describing the hypothetical participant, not
   * because it changes anything — it writes nothing and schedules nothing.
   */
  @Post(":protocolId/preview")
  @HttpCode(HttpStatus.OK)
  @RequireStudyPermission("protocol:edit")
  async preview(
    @Param("studyId") _studyId: string,
    @Param("protocolId", uuidParam(ApiErrors.protocolNotFound)) protocolId: string,
    @Body(new ZodBodyPipe(previewProtocolSchema)) body: PreviewProtocolRequest,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<ProtocolPreviewResponse> {
    return this.protocols.preview(access.studyId, protocolId, null, body);
  }

  @Post(":protocolId/versions/:versionId/preview")
  @HttpCode(HttpStatus.OK)
  @RequireStudyPermission("protocol:edit")
  async previewVersion(
    @Param("studyId") _studyId: string,
    @Param("protocolId", uuidParam(ApiErrors.protocolNotFound)) protocolId: string,
    @Param("versionId", uuidParam(ApiErrors.protocolNotFound)) versionId: string,
    @Body(new ZodBodyPipe(previewProtocolSchema)) body: PreviewProtocolRequest,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<ProtocolPreviewResponse> {
    return this.protocols.preview(access.studyId, protocolId, versionId, body);
  }

  // ── steps, always against the draft ───────────────────────────────────────

  @Post(":protocolId/steps")
  @HttpCode(HttpStatus.CREATED)
  @RequireStudyPermission("protocol:edit")
  async createStep(
    @Param("studyId") _studyId: string,
    @Param("protocolId", uuidParam(ApiErrors.protocolNotFound)) protocolId: string,
    @Body(new ZodBodyPipe(protocolStepInputSchema)) body: ProtocolStepInput,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProtocolStepResponse> {
    return this.steps.create(
      user,
      access.studyId,
      protocolId,
      body,
      this.clock.now(),
      context(request),
    );
  }

  @Put(":protocolId/steps/order")
  @RequireStudyPermission("protocol:edit")
  async reorderSteps(
    @Param("studyId") _studyId: string,
    @Param("protocolId", uuidParam(ApiErrors.protocolNotFound)) protocolId: string,
    @Body(new ZodBodyPipe(reorderProtocolStepsSchema)) body: ReorderProtocolStepsRequest,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<{ steps: ProtocolStepResponse[] }> {
    return {
      steps: await this.steps.reorder(
        user,
        access.studyId,
        protocolId,
        body.stepIds,
        this.clock.now(),
        context(request),
      ),
    };
  }

  @Patch(":protocolId/steps/:stepId")
  @RequireStudyPermission("protocol:edit")
  async updateStep(
    @Param("studyId") _studyId: string,
    @Param("protocolId", uuidParam(ApiErrors.protocolNotFound)) protocolId: string,
    @Param("stepId", uuidParam(ApiErrors.protocolStepNotFound)) stepId: string,
    @Body(new ZodBodyPipe(updateProtocolStepSchema)) body: UpdateProtocolStepRequest,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<ProtocolStepResponse> {
    return this.steps.update(
      user,
      access.studyId,
      protocolId,
      stepId,
      body,
      this.clock.now(),
      context(request),
    );
  }

  @Delete(":protocolId/steps/:stepId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireStudyPermission("protocol:edit")
  async deleteStep(
    @Param("studyId") _studyId: string,
    @Param("protocolId", uuidParam(ApiErrors.protocolNotFound)) protocolId: string,
    @Param("stepId", uuidParam(ApiErrors.protocolStepNotFound)) stepId: string,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.steps.remove(
      user,
      access.studyId,
      protocolId,
      stepId,
      this.clock.now(),
      context(request),
    );
  }
}

function context(request: AuthenticatedRequest) {
  return { ip: request.ip, userAgent: request.headers["user-agent"] };
}
