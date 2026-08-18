import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from "@nestjs/common";
import { toString as qrToString } from "qrcode";
import {
  addStudyMemberRequestSchema,
  changeStudyStatusRequestSchema,
  createStudyRequestSchema,
  updateStudyMemberRequestSchema,
  updateStudyRequestSchema,
  type AddStudyMemberRequest,
  type ChangeStudyStatusRequest,
  type CreateStudyRequest,
  type ResearcherProfile,
  type StudyListResponse,
  type StudyMemberListResponse,
  type StudyMemberResponse,
  type StudyResponse,
  type UpdateStudyMemberRequest,
  type UpdateStudyRequest,
} from "@lpr/contracts";
import { ClockService } from "../../common/core.module.js";
import { ZodBodyPipe } from "../../common/zod-body.pipe.js";
import { CurrentUser, StudyAccess } from "../auth/decorators/current-user.decorator.js";
import { RequireStudyPermission } from "../auth/decorators/require-study-permission.decorator.js";
import type { AuthenticatedRequest, RequestStudyAccess } from "../auth/auth.types.js";
import { StudyMemberService } from "./study-member.service.js";
import { StudyService } from "./study.service.js";

@Controller("api/studies")
export class StudyController {
  constructor(
    private readonly studies: StudyService,
    private readonly members: StudyMemberService,
    private readonly clock: ClockService,
  ) {}

  /**
   * `GET /api/studies` — the caller's studies, and only those.
   *
   * No permission decorator: this route is not scoped to one study, and the
   * membership join in the service IS the authorization.
   */
  @Get()
  async list(@CurrentUser() user: ResearcherProfile): Promise<StudyListResponse> {
    return { studies: await this.studies.listForUser(user.id) };
  }

  /**
   * `POST /api/studies` — any authenticated researcher may create a study, and
   * becomes its OWNER. There is no platform-level "may create studies"
   * permission: the four roles are study-scoped, so a user with no studies has
   * no roles at all and could otherwise never start.
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body(new ZodBodyPipe(createStudyRequestSchema)) body: CreateStudyRequest,
    @CurrentUser() user: ResearcherProfile,
    @Req() request: AuthenticatedRequest,
  ): Promise<StudyResponse> {
    return this.studies.create(user, body, this.clock.now(), context(request));
  }

  @Get(":studyId")
  @RequireStudyPermission("study:view")
  async get(
    @Param("studyId") _studyId: string,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<StudyResponse> {
    return this.studies.getForUser(access.studyId, access.role);
  }

  @Patch(":studyId")
  @RequireStudyPermission("study:edit")
  async update(
    @Param("studyId") _studyId: string,
    @Body(new ZodBodyPipe(updateStudyRequestSchema)) body: UpdateStudyRequest,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<StudyResponse> {
    return this.studies.update(
      user,
      access.studyId,
      access.role,
      body,
      this.clock.now(),
      context(request),
    );
  }

  /**
   * `PUT /api/studies/:studyId/status` — OWNER only.
   *
   * A separate endpoint rather than a field on PATCH, so the change is
   * validated as a TRANSITION, guarded at a higher permission, and audited
   * with both the old and new status.
   */
  @Put(":studyId/status")
  @RequireStudyPermission("study:lifecycle")
  async changeStatus(
    @Param("studyId") _studyId: string,
    @Body(new ZodBodyPipe(changeStudyStatusRequestSchema)) body: ChangeStudyStatusRequest,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<StudyResponse> {
    return this.studies.changeStatus(
      user,
      access.studyId,
      access.role,
      body.status,
      this.clock.now(),
      context(request),
    );
  }

  /**
   * `GET /api/studies/:studyId/qr` — the enrollment QR code (FR-02).
   *
   * SVG rather than PNG: it prints at any size on a poster without pixelating,
   * which is the actual use. The URL it encodes is built from the participant
   * origin by the same function that produces `enrollmentUrl`, so the poster
   * and the dashboard can never disagree.
   */
  @Get(":studyId/qr")
  @RequireStudyPermission("study:view")
  @Header("Content-Type", "image/svg+xml")
  @Header("Cache-Control", "private, max-age=300")
  // The body is generated markup, not user input — but an SVG served without
  // this can be sniffed into something the browser executes, and the cost of
  // stating the type is nil.
  @Header("X-Content-Type-Options", "nosniff")
  async qrCode(
    @Param("studyId") _studyId: string,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<string> {
    const url = await this.studies.enrollmentUrl(access.studyId);
    return qrToString(url, {
      type: "svg",
      // Q tolerates ~25% damage — a printed poster gets scuffed, and a code
      // that stops scanning halfway through recruitment costs participants.
      errorCorrectionLevel: "Q",
      margin: 2,
    });
  }

  // ─────────────────────────── Membership ──────────────────────────────────

  @Get(":studyId/members")
  @RequireStudyPermission("study:members:manage")
  async listMembers(
    @Param("studyId") _studyId: string,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<StudyMemberListResponse> {
    return { members: await this.members.list(access.studyId) };
  }

  @Post(":studyId/members")
  @HttpCode(HttpStatus.CREATED)
  @RequireStudyPermission("study:members:manage")
  async addMember(
    @Param("studyId") _studyId: string,
    @Body(new ZodBodyPipe(addStudyMemberRequestSchema)) body: AddStudyMemberRequest,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<StudyMemberResponse> {
    return this.members.add(
      user,
      access.studyId,
      body.email,
      body.role,
      this.clock.now(),
      context(request),
    );
  }

  @Patch(":studyId/members/:userId")
  @RequireStudyPermission("study:members:manage")
  async changeMemberRole(
    @Param("studyId") _studyId: string,
    @Param("userId") userId: string,
    @Body(new ZodBodyPipe(updateStudyMemberRequestSchema)) body: UpdateStudyMemberRequest,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<StudyMemberResponse> {
    return this.members.changeRole(
      user,
      access.studyId,
      userId,
      body.role,
      this.clock.now(),
      context(request),
    );
  }

  @Delete(":studyId/members/:userId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireStudyPermission("study:members:manage")
  async removeMember(
    @Param("studyId") _studyId: string,
    @Param("userId") userId: string,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<void> {
    await this.members.remove(user, access.studyId, userId, this.clock.now(), context(request));
  }
}

function context(request: AuthenticatedRequest) {
  return { ip: request.ip, userAgent: request.headers["user-agent"] };
}
