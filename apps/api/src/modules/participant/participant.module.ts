import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuditModule } from "../audit/audit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { ContinuityService } from "./continuity.service.js";
import { ParticipantAuthGuard } from "./guards/participant-auth.guard.js";
import { ParticipantController } from "./participant.controller.js";
import { ParticipantService } from "./participant.service.js";

/**
 * Participants (PLAN.md Phase 5).
 *
 * `ParticipantAuthGuard` is registered globally so that a route marked
 * `@ParticipantRoute()` is resolved wherever it lives, including the session
 * and response modules that arrive in Phase 6. It is inert on every other
 * route: without the marker it returns immediately, and the global researcher
 * guard still applies.
 *
 * `AuthModule` is imported for its rate limiter, which enrollment and recovery
 * share with login — one limiter, one place its behaviour is defined.
 */
@Module({
  imports: [AuditModule, AuthModule],
  controllers: [ParticipantController],
  providers: [
    ParticipantService,
    ContinuityService,
    { provide: APP_GUARD, useClass: ParticipantAuthGuard },
  ],
  exports: [ParticipantService, ContinuityService],
})
export class ParticipantModule {}
