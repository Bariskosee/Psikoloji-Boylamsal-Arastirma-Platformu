import { Module } from "@nestjs/common";
import { AuditController } from "./audit.controller.js";
import { AuditService } from "./audit.service.js";

/**
 * Audit recording and the study audit view (NFR-05).
 *
 * Exported, because almost every other module writes to the trail. The
 * controller is here rather than in the study module so that everything which
 * touches audit data — the writer and the only reader — sits behind one
 * boundary.
 */
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
