import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { PushController } from "./push.controller.js";
import { PushService } from "./push.service.js";

/**
 * Push subscriptions (PLAN.md Phase 8, ADR-006).
 *
 * `AuthModule` is imported for the shared rate limiter, as the participant
 * module does. The participant guard itself is registered globally by
 * `ParticipantModule`, so a `@ParticipantRoute()` here resolves without this
 * module importing it — which is what keeps the dependency one-directional:
 * `ParticipantModule` imports this one so that withdrawal can silence a
 * participant's devices inside its own transaction.
 */
@Module({
  imports: [AuthModule],
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
