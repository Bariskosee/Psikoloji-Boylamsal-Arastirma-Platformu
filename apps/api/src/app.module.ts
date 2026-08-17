import { Module } from "@nestjs/common";
import { HealthModule } from "./modules/health/health.module.js";

/**
 * Root module.
 *
 * Each domain gets its own NestJS module with declared imports and providers,
 * so the boundaries in STRUCTURE.md §5 are enforced by the compiler rather
 * than maintained by convention (ADR-002).
 *
 * Phase 0 registers only HealthModule. The domain modules — auth, study,
 * consent, questionnaire, protocol, participant, session, response,
 * notification, analytics, export, audit — arrive in Phases 2 onward.
 */
@Module({
  imports: [HealthModule],
})
export class AppModule {}
