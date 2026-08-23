import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { ExportController } from "./export.controller.js";
import { ExportService } from "./export.service.js";

/**
 * Data export (PLAN.md Phase 11).
 *
 * Runs entirely on the analytics connection from the global `DatabaseModule`,
 * so §6.1's guarantee — exports carry `public_code` and no contact detail, no
 * endpoint, no credential — is enforced by the database role rather than by
 * anyone remembering it while writing a query.
 */
@Module({
  imports: [AuditModule, AuthModule],
  controllers: [ExportController],
  providers: [ExportService],
  exports: [ExportService],
})
export class ExportModule {}
