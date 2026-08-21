import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import {
  saveAnswersSchema,
  type CompleteSessionResponse,
  type SaveAnswersRequest,
  type SaveAnswersResponse,
  type SessionDetail,
  type SessionListResponse,
} from "@lpr/contracts";
import { ApiErrors } from "../../common/api-error.js";
import { ClockService } from "../../common/core.module.js";
import { uuidParam } from "../../common/uuid-param.pipe.js";
import { ZodBodyPipe } from "../../common/zod-body.pipe.js";
import { Public } from "../auth/decorators/public.decorator.js";
import {
  CurrentParticipant,
  ParticipantRoute,
} from "../participant/decorators/participant-route.decorator.js";
import { SessionService } from "./session.service.js";

/**
 * `/api/participant/sessions/**` (PLAN.md Phase 6).
 *
 * Every route is a participant route: the caller is resolved from the
 * continuity cookie, and the service matches the session against that
 * participant inside the query rather than checking ownership afterwards.
 *
 * A withdrawn participant is refused before any handler runs — their sessions
 * are cancelled, but the refusal should not depend on that having happened yet.
 */
@Controller("api/participant/sessions")
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly clock: ClockService,
  ) {}

  @ParticipantRoute()
  @Public()
  @Get()
  async list(
    @CurrentParticipant() participant: { id: string; status: string },
  ): Promise<SessionListResponse> {
    assertActive(participant);
    return this.sessions.list(participant.id);
  }

  @ParticipantRoute()
  @Public()
  @Get(":sessionId")
  async detail(
    @CurrentParticipant() participant: { id: string; status: string },
    @Param("sessionId", uuidParam(ApiErrors.sessionNotFound)) sessionId: string,
  ): Promise<SessionDetail> {
    assertActive(participant);
    return this.sessions.detail(participant.id, sessionId, this.clock.now());
  }

  /**
   * Autosave.
   *
   * A POST that is safe to retry: each answer carries a monotonic revision, so
   * a repeated request is a no-op rather than a duplicate write. That is what
   * lets the client's outbox replay without coordination after a reconnection.
   */
  @ParticipantRoute()
  @Public()
  @Post(":sessionId/answers")
  @HttpCode(HttpStatus.OK)
  async saveAnswers(
    @CurrentParticipant() participant: { id: string; status: string },
    @Param("sessionId", uuidParam(ApiErrors.sessionNotFound)) sessionId: string,
    @Body(new ZodBodyPipe(saveAnswersSchema)) body: SaveAnswersRequest,
  ): Promise<SaveAnswersResponse> {
    assertActive(participant);
    return this.sessions.saveAnswers(participant.id, sessionId, body.answers, this.clock.now());
  }

  @ParticipantRoute()
  @Public()
  @Post(":sessionId/complete")
  @HttpCode(HttpStatus.OK)
  async complete(
    @CurrentParticipant() participant: { id: string; status: string },
    @Param("sessionId", uuidParam(ApiErrors.sessionNotFound)) sessionId: string,
  ): Promise<CompleteSessionResponse> {
    assertActive(participant);
    return this.sessions.complete(participant.id, sessionId, this.clock.now());
  }
}

function assertActive(participant: { status: string }): void {
  if (participant.status === "WITHDRAWN") throw ApiErrors.participantWithdrawn();
}
