import { SetMetadata, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { ParticipantRequest } from "../guards/participant-auth.guard.js";

export const IS_PARTICIPANT_ROUTE = "lpr:isParticipantRoute";

/**
 * Marks a route as authenticated by the participant continuity cookie rather
 * than by a researcher session. Also implies `@Public()`, because the global
 * researcher guard must not run on it.
 */
export const ParticipantRoute = () => SetMetadata(IS_PARTICIPANT_ROUTE, true);

export const CurrentParticipant = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const request = context.switchToHttp().getRequest<ParticipantRequest>();
    if (!request.participant) {
      throw new Error("CurrentParticipant used on a route without @ParticipantRoute()");
    }
    return request.participant;
  },
);
