import { Module } from "@nestjs/common";
import { MaterialisationService } from "./materialisation.service.js";

/**
 * The scheduling engine (PLAN.md Phase 7).
 *
 * Materialisation and trigger propagation only. The handlers and sweepers that
 * ACT on what this writes live in the worker — the API never activates or
 * expires a session, so a busy request path cannot be the reason a window
 * opened late.
 */
@Module({
  providers: [MaterialisationService],
  exports: [MaterialisationService],
})
export class SchedulingModule {}
