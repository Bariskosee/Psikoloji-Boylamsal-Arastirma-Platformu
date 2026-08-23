import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { MailModule } from "../mail/mail.module.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { PasswordResetService } from "./password-reset.service.js";
import { PasswordService } from "./password.service.js";
import { RateLimitService } from "./rate-limit.service.js";
import { SessionService } from "./session.service.js";

/**
 * Researcher authentication.
 *
 * `SessionService` is exported because the global SessionAuthGuard resolves
 * every request through it. The guards themselves are registered in AppModule
 * as APP_GUARD providers, so they apply to routes in every module rather than
 * to whatever a controller author remembered to decorate.
 */
@Module({
  imports: [AuditModule, MailModule],
  controllers: [AuthController],
  providers: [AuthService, PasswordResetService, SessionService, PasswordService, RateLimitService],
  exports: [SessionService, PasswordService, RateLimitService, PasswordResetService],
})
export class AuthModule {}
