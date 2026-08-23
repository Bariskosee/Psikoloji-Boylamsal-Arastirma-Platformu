import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { AnalyticsController, OperationsController } from "./analytics.controller.js";
import { AnalyticsService } from "./analytics.service.js";
import { InspectorService } from "./inspector.service.js";
import { OperationsService } from "./operations.service.js";

/**
 * Monitoring and compliance (PLAN.md Phase 10).
 *
 * Two connections, deliberately: `AnalyticsService` and `InspectorService` run
 * on the restricted analytics role, while `OperationsService` needs the
 * ordinary one because sweeper heartbeats, dead letters and push attrition live
 * outside what analytics may see. Both come from the global `DatabaseModule`,
 * so neither service can pick the wrong one by accident — the injection token
 * is the choice.
 */
@Module({
  imports: [AuditModule],
  controllers: [AnalyticsController, OperationsController],
  providers: [AnalyticsService, InspectorService, OperationsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
