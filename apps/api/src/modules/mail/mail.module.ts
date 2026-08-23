import { Global, Module } from "@nestjs/common";
import { MailService } from "./mail.service.js";

/**
 * Outbound email.
 *
 * Global because the transport is a single connection pool and there is no
 * sense in constructing one per consumer — and because the set of things this
 * platform emails is deliberately tiny (one message, to researchers only), so
 * there is nothing to scope.
 */
@Global()
@Module({
  providers: [MailService],
  exports: [MailService],
})
export class MailModule {}
