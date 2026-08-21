import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { eq } from "drizzle-orm";
import type { Request, Response } from "express";
import { PARTICIPANT_COOKIE_NAME, PARTICIPANT_COOKIE_MAX_AGE_MS } from "@lpr/contracts";
import { participants, type Database } from "@lpr/db";
import { Inject } from "@nestjs/common";
import { ApiErrors } from "../../../common/api-error.js";
import { readCookie, setParticipantCookie } from "../../../common/cookies.js";
import { ClockService } from "../../../common/core.module.js";
import { loadEnv, shouldUseSecureCookies } from "../../../config/env.js";
import { DATABASE } from "../../database/database.module.js";
import { ContinuityService } from "../continuity.service.js";
import { IS_PARTICIPANT_ROUTE } from "../decorators/participant-route.decorator.js";

export interface ParticipantRequest extends Request {
  participant?: { id: string; status: string };
}

/**
 * Resolves the continuity cookie on participant routes (STRUCTURE.md §11.3).
 *
 * Opt-IN rather than opt-out, the mirror of the researcher guard: participant
 * routes are a small, explicitly marked set, and the global researcher guard
 * already covers everything else. A route that forgets the marker is refused
 * by the researcher guard, which fails closed.
 *
 * ── Rotation happens here ───────────────────────────────────────────────────
 * A credential past its rotation age is replaced during the request that used
 * it, and the new token goes out as a cookie on the same response. The old one
 * keeps working for its grace period so requests already in flight — a page
 * load, an autosave — do not fail and sign someone out mid-questionnaire.
 *
 * Every failure produces ONE error. "No cookie", "unknown token", "revoked"
 * and "grace expired" are indistinguishable to the caller, because telling
 * them apart confirms whether a token they hold ever existed.
 */
@Injectable()
export class ParticipantAuthGuard implements CanActivate {
  private readonly env = loadEnv();

  constructor(
    private readonly reflector: Reflector,
    private readonly continuity: ContinuityService,
    private readonly clock: ClockService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isParticipantRoute = this.reflector.getAllAndOverride<boolean>(IS_PARTICIPANT_ROUTE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isParticipantRoute) return true;

    const request = context.switchToHttp().getRequest<ParticipantRequest>();
    const response = context.switchToHttp().getResponse<Response>();

    const token = readCookie(request.cookies, PARTICIPANT_COOKIE_NAME);
    if (token === undefined) throw ApiErrors.participantAuthRequired();

    const now = this.clock.now();
    const resolved = await this.continuity.resolve(token, now);
    if (!resolved.ok) throw ApiErrors.participantAuthRequired();

    const participant = (
      await this.db
        .select({ id: participants.id, status: participants.status })
        .from(participants)
        .where(eq(participants.id, resolved.participantId))
        .limit(1)
    )[0];
    if (!participant) throw ApiErrors.participantAuthRequired();

    if (resolved.rotate) {
      const minted = await this.continuity.rotate(resolved.credentialId, participant.id, now);
      setParticipantCookie(response, minted.token, {
        secure: shouldUseSecureCookies(this.env),
        maxAgeMs: PARTICIPANT_COOKIE_MAX_AGE_MS,
      });
    } else {
      await this.continuity.touch(resolved.credentialId, now);
    }

    request.participant = participant;
    return true;
  }
}
