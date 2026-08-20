import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { ProtocolController } from "./protocol.controller.js";
import { ProtocolStepService } from "./protocol-step.service.js";
import { ProtocolService } from "./protocol.service.js";

/**
 * The protocol builder (PLAN.md Phase 4).
 *
 * Definition only: this module writes protocol rows and validates them.
 * Nothing here materialises a session, enqueues a job, or starts an engine —
 * that is Phase 7 against the handler contract in ADR-005.
 *
 * `ProtocolService` is exported because Phase 5's enrollment must resolve and
 * pin a published protocol version. `ProtocolStepService` is not: step writes
 * are builder-internal.
 */
@Module({
  imports: [AuditModule],
  controllers: [ProtocolController],
  providers: [ProtocolService, ProtocolStepService],
  exports: [ProtocolService],
})
export class ProtocolModule {}
