import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module.js";
import { NotificationController } from "./notification.controller.js";
import { NotificationService } from "./notification.service.js";

/**
 * Notifications, participant side (PLAN.md Phase 9).
 *
 * Deliberately thin, and deliberately does not import the job queue. Sending
 * belongs to the worker: it holds the VAPID private key, and a reminder chain
 * driven from a request handler would depend on an API instance being awake at
 * the right minute — which on a platform that scales to zero it will not be.
 */
@Module({
  imports: [AuthModule],
  controllers: [NotificationController],
  providers: [NotificationService],
  exports: [NotificationService],
})
export class NotificationModule {}
