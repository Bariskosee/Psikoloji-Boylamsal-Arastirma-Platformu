import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { ConsentController } from "./consent.controller.js";
import { ConsentService } from "./consent.service.js";

/**
 * Consent documents (PLAN.md Phase 5).
 *
 * `ConsentService` is exported because enrollment must resolve the study's
 * current published version before it can record what a participant agreed to.
 */
@Module({
  imports: [AuditModule],
  controllers: [ConsentController],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
