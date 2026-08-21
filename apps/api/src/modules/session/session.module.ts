import { Module } from "@nestjs/common";
import { ParticipantModule } from "../participant/participant.module.js";
import { SessionController } from "./session.controller.js";
import { SessionService } from "./session.service.js";

/**
 * The questionnaire runtime (PLAN.md Phase 6).
 *
 * Depends on `ParticipantModule` for the continuity guard that resolves the
 * caller. Sessions themselves are created by test fixtures in this phase; the
 * engine that materialises them from a protocol is Phase 7.
 */
@Module({
  imports: [ParticipantModule],
  controllers: [SessionController],
  providers: [SessionService],
  exports: [SessionService],
})
export class SessionModule {}
