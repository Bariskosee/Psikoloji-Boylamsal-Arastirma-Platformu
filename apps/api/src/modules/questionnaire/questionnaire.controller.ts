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
  createQuestionOptionRequestSchema,
  createQuestionRequestSchema,
  createQuestionnaireRequestSchema,
  reorderOptionsRequestSchema,
  reorderQuestionsRequestSchema,
  updateQuestionOptionRequestSchema,
  updateQuestionRequestSchema,
  updateQuestionnaireRequestSchema,
  type CreateQuestionOptionRequest,
  type CreateQuestionRequest,
  type CreateQuestionnaireRequest,
  type QuestionOptionResponse,
  type QuestionResponse,
  type QuestionnaireDetail,
  type QuestionnaireListResponse,
  type QuestionnaireSummary,
  type QuestionnaireVersionDetail,
  type ReorderOptionsRequest,
  type ReorderQuestionsRequest,
  type ResearcherProfile,
  type UpdateQuestionOptionRequest,
  type UpdateQuestionRequest,
  type UpdateQuestionnaireRequest,
} from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { ClockService } from "../../common/core.module.js";
import { uuidParam } from "../../common/uuid-param.pipe.js";
import { ZodBodyPipe } from "../../common/zod-body.pipe.js";
import { CurrentUser, StudyAccess } from "../auth/decorators/current-user.decorator.js";
import { RequireStudyPermission } from "../auth/decorators/require-study-permission.decorator.js";
import type { AuthenticatedRequest, RequestStudyAccess } from "../auth/auth.types.js";
import { QuestionService } from "./question.service.js";
import { QuestionnaireService } from "./questionnaire.service.js";

/**
 * `/api/studies/:studyId/questionnaires/**` (PLAN.md Phase 3).
 *
 * ── Why reads require EDITOR too ─────────────────────────────────────────────
 * STRUCTURE.md §12 puts this entire resource at EDITOR, alongside
 * consent-versions, and that is what is implemented here — `questionnaire:edit`
 * on every route, read and write alike. A VIEWER's remit is "aggregate
 * monitoring only" (REQUIREMENTS.md §5.2), which the analytics endpoints serve;
 * the instrument definition is builder surface. Widening a read later is a
 * one-line change and safe. Starting wide and narrowing afterwards is not.
 *
 * The guard resolves the permission against the membership row for `:studyId`,
 * and every service call takes `access.studyId` — the value the guard verified
 * — rather than re-reading the path parameter, so a handler cannot accidentally
 * act on a study the guard never checked.
 *
 * Note what is NOT here: no route accepts a version id for a write. Question
 * and option mutations resolve the questionnaire's current DRAFT server-side,
 * which makes "edit a published version" unrepresentable in the URL space
 * rather than merely rejected (AGENT.md §17).
 */
@Controller("api/studies/:studyId/questionnaires")
export class QuestionnaireController {
  constructor(
    private readonly questionnaires: QuestionnaireService,
    private readonly questions: QuestionService,
    private readonly clock: ClockService,
  ) {}

  @Get()
  @RequireStudyPermission("questionnaire:edit")
  async list(
    @Param("studyId") _studyId: string,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<QuestionnaireListResponse> {
    return { questionnaires: await this.questionnaires.list(access.studyId) };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequireStudyPermission("questionnaire:edit")
  async create(
    @Param("studyId") _studyId: string,
    @Body(new ZodBodyPipe(createQuestionnaireRequestSchema)) body: CreateQuestionnaireRequest,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<QuestionnaireDetail> {
    return this.questionnaires.create(
      user,
      access.studyId,
      body,
      this.clock.now(),
      context(request),
    );
  }

  @Get(":questionnaireId")
  @RequireStudyPermission("questionnaire:edit")
  async get(
    @Param("studyId") _studyId: string,
    @Param("questionnaireId", uuidParam(ApiErrors.questionnaireNotFound))
    questionnaireId: string,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<QuestionnaireDetail> {
    return this.questionnaires.get(access.studyId, questionnaireId);
  }

  @Patch(":questionnaireId")
  @RequireStudyPermission("questionnaire:edit")
  async update(
    @Param("studyId") _studyId: string,
    @Param("questionnaireId", uuidParam(ApiErrors.questionnaireNotFound))
    questionnaireId: string,
    @Body(new ZodBodyPipe(updateQuestionnaireRequestSchema)) body: UpdateQuestionnaireRequest,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<QuestionnaireSummary> {
    return this.questionnaires.update(
      user,
      access.studyId,
      questionnaireId,
      body,
      this.clock.now(),
      context(request),
    );
  }

  /**
   * `GET .../versions/:versionId` — any version, draft or published.
   *
   * This is how the researcher UI proves to itself that version 1 is unchanged
   * after version 2 is published, and how a later phase's participant runtime
   * will read the version a session was assigned.
   */
  @Get(":questionnaireId/versions/:versionId")
  @RequireStudyPermission("questionnaire:edit")
  async getVersion(
    @Param("studyId") _studyId: string,
    @Param("questionnaireId", uuidParam(ApiErrors.questionnaireNotFound))
    questionnaireId: string,
    @Param("versionId", uuidParam(ApiErrors.questionnaireNotFound)) versionId: string,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<QuestionnaireVersionDetail> {
    return this.questionnaires.getVersion(access.studyId, questionnaireId, versionId);
  }

  /**
   * `POST .../publish` — the irreversible one.
   *
   * POST rather than PUT: it is not idempotent, it creates a new resource (a
   * version), and calling it twice deliberately produces two versions.
   */
  @Post(":questionnaireId/publish")
  @HttpCode(HttpStatus.CREATED)
  @RequireStudyPermission("questionnaire:edit")
  async publish(
    @Param("studyId") _studyId: string,
    @Param("questionnaireId", uuidParam(ApiErrors.questionnaireNotFound))
    questionnaireId: string,
    @CurrentUser() user: ResearcherProfile,
    @StudyAccess() access: RequestStudyAccess,
    @Req() request: AuthenticatedRequest,
  ): Promise<QuestionnaireVersionDetail> {
    return this.questionnaires.publish(
      user,
      access.studyId,
      questionnaireId,
      this.clock.now(),
      context(request),
    );
  }

  // ─────────────────────────────── Questions ────────────────────────────────

  @Post(":questionnaireId/questions")
  @HttpCode(HttpStatus.CREATED)
  @RequireStudyPermission("questionnaire:edit")
  async createQuestion(
    @Param("studyId") _studyId: string,
    @Param("questionnaireId", uuidParam(ApiErrors.questionnaireNotFound))
    questionnaireId: string,
    @Body(new ZodBodyPipe(createQuestionRequestSchema)) body: CreateQuestionRequest,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<QuestionResponse> {
    return this.questions.createQuestion(access.studyId, questionnaireId, body, this.clock.now());
  }

  /**
   * `PUT .../questions/order` — declared before `:questionId` routes of the
   * same method would be, and on a distinct verb from them in any case, so
   * "order" can never be read as a question id.
   */
  @Put(":questionnaireId/questions/order")
  @RequireStudyPermission("questionnaire:edit")
  async reorderQuestions(
    @Param("studyId") _studyId: string,
    @Param("questionnaireId", uuidParam(ApiErrors.questionnaireNotFound))
    questionnaireId: string,
    @Body(new ZodBodyPipe(reorderQuestionsRequestSchema)) body: ReorderQuestionsRequest,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<{ questions: QuestionResponse[] }> {
    return {
      questions: await this.questions.reorderQuestions(
        access.studyId,
        questionnaireId,
        body,
        this.clock.now(),
      ),
    };
  }

  @Patch(":questionnaireId/questions/:questionId")
  @RequireStudyPermission("questionnaire:edit")
  async updateQuestion(
    @Param("studyId") _studyId: string,
    @Param("questionnaireId", uuidParam(ApiErrors.questionnaireNotFound))
    questionnaireId: string,
    @Param("questionId", uuidParam(ApiErrors.questionNotFound)) questionId: string,
    @Body(new ZodBodyPipe(updateQuestionRequestSchema)) body: UpdateQuestionRequest,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<QuestionResponse> {
    return this.questions.updateQuestion(
      access.studyId,
      questionnaireId,
      questionId,
      body,
      this.clock.now(),
    );
  }

  @Delete(":questionnaireId/questions/:questionId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireStudyPermission("questionnaire:edit")
  async deleteQuestion(
    @Param("studyId") _studyId: string,
    @Param("questionnaireId", uuidParam(ApiErrors.questionnaireNotFound))
    questionnaireId: string,
    @Param("questionId", uuidParam(ApiErrors.questionNotFound)) questionId: string,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<void> {
    await this.questions.deleteQuestion(access.studyId, questionnaireId, questionId);
  }

  // ──────────────────────────────── Options ─────────────────────────────────

  @Post(":questionnaireId/questions/:questionId/options")
  @HttpCode(HttpStatus.CREATED)
  @RequireStudyPermission("questionnaire:edit")
  async createOption(
    @Param("studyId") _studyId: string,
    @Param("questionnaireId", uuidParam(ApiErrors.questionnaireNotFound))
    questionnaireId: string,
    @Param("questionId", uuidParam(ApiErrors.questionNotFound)) questionId: string,
    @Body(new ZodBodyPipe(createQuestionOptionRequestSchema)) body: CreateQuestionOptionRequest,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<QuestionOptionResponse> {
    return this.questions.createOption(
      access.studyId,
      questionnaireId,
      questionId,
      body,
      this.clock.now(),
    );
  }

  @Put(":questionnaireId/questions/:questionId/options/order")
  @RequireStudyPermission("questionnaire:edit")
  async reorderOptions(
    @Param("studyId") _studyId: string,
    @Param("questionnaireId", uuidParam(ApiErrors.questionnaireNotFound))
    questionnaireId: string,
    @Param("questionId", uuidParam(ApiErrors.questionNotFound)) questionId: string,
    @Body(new ZodBodyPipe(reorderOptionsRequestSchema)) body: ReorderOptionsRequest,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<{ options: QuestionOptionResponse[] }> {
    return {
      options: await this.questions.reorderOptions(
        access.studyId,
        questionnaireId,
        questionId,
        body,
        this.clock.now(),
      ),
    };
  }

  @Patch(":questionnaireId/questions/:questionId/options/:optionId")
  @RequireStudyPermission("questionnaire:edit")
  async updateOption(
    @Param("studyId") _studyId: string,
    @Param("questionnaireId", uuidParam(ApiErrors.questionnaireNotFound))
    questionnaireId: string,
    @Param("questionId", uuidParam(ApiErrors.questionNotFound)) questionId: string,
    @Param("optionId", uuidParam(ApiErrors.questionOptionNotFound)) optionId: string,
    @Body(new ZodBodyPipe(updateQuestionOptionRequestSchema)) body: UpdateQuestionOptionRequest,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<QuestionOptionResponse> {
    return this.questions.updateOption(
      access.studyId,
      questionnaireId,
      questionId,
      optionId,
      body,
      this.clock.now(),
    );
  }

  @Delete(":questionnaireId/questions/:questionId/options/:optionId")
  @HttpCode(HttpStatus.NO_CONTENT)
  @RequireStudyPermission("questionnaire:edit")
  async deleteOption(
    @Param("studyId") _studyId: string,
    @Param("questionnaireId", uuidParam(ApiErrors.questionnaireNotFound))
    questionnaireId: string,
    @Param("questionId", uuidParam(ApiErrors.questionNotFound)) questionId: string,
    @Param("optionId", uuidParam(ApiErrors.questionOptionNotFound)) optionId: string,
    @StudyAccess() access: RequestStudyAccess,
  ): Promise<void> {
    await this.questions.deleteOption(access.studyId, questionnaireId, questionId, optionId);
  }
}

function context(request: AuthenticatedRequest) {
  return { ip: request.ip, userAgent: request.headers["user-agent"] };
}
