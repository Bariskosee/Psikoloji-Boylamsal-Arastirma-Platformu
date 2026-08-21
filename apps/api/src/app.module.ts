import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ApiExceptionFilter } from "./common/api-exception.filter.js";
import { CoreModule } from "./common/core.module.js";
import { AuditModule } from "./modules/audit/audit.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { CsrfGuard } from "./modules/auth/guards/csrf.guard.js";
import { SessionAuthGuard } from "./modules/auth/guards/session-auth.guard.js";
import { StudyPermissionGuard } from "./modules/auth/guards/study-permission.guard.js";
import { DatabaseModule } from "./modules/database/database.module.js";
import { HealthModule } from "./modules/health/health.module.js";
import { ConsentModule } from "./modules/consent/consent.module.js";
import { ParticipantModule } from "./modules/participant/participant.module.js";
import { ProtocolModule } from "./modules/protocol/protocol.module.js";
import { SchedulingModule } from "./modules/scheduling/scheduling.module.js";
import { SessionModule } from "./modules/session/session.module.js";
import { QuestionnaireModule } from "./modules/questionnaire/questionnaire.module.js";
import { StudyModule } from "./modules/study/study.module.js";

/**
 * Root module.
 *
 * Each domain gets its own NestJS module with declared imports and providers,
 * so the boundaries in STRUCTURE.md §5 are enforced by the compiler rather
 * than maintained by convention (ADR-002).
 *
 * ── Why the guards are GLOBAL ────────────────────────────────────────────────
 * Authentication and CSRF are opt-out (`@Public()`), not opt-in. A controller
 * added in a later phase is protected the moment it exists. The inverse — a
 * `@UseGuards` on each controller — fails open: one forgotten decorator serves
 * participant responses to anyone, and nothing about the code looks wrong.
 *
 * Order is significant. Nest runs global guards in registration order:
 *
 *   SessionAuthGuard      resolves the session cookie → request.auth
 *   CsrfGuard             needs request.auth for the double-submit comparison
 *   StudyPermissionGuard  needs request.auth for the membership lookup
 *
 * The remaining domain modules — consent, protocol, participant, session,
 * response, notification, analytics, export — arrive in Phase 4 onward.
 */
@Module({
  imports: [
    CoreModule,
    DatabaseModule,
    HealthModule,
    AuthModule,
    AuditModule,
    StudyModule,
    QuestionnaireModule,
    ProtocolModule,
    ConsentModule,
    ParticipantModule,
    SessionModule,
    SchedulingModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
    { provide: APP_GUARD, useClass: SessionAuthGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: StudyPermissionGuard },
  ],
})
export class AppModule {}
