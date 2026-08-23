// Must be the FIRST import: populates process.env before anything reads it.
import "./config/load-env.js";
import "reflect-metadata";
import * as Sentry from "@sentry/node";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import cookieParser from "cookie-parser";
import { CSRF_HEADER } from "@lpr/contracts";
import { AppModule } from "./app.module.js";
import { loadEnv } from "./config/env.js";

async function bootstrap(): Promise<void> {
  const env = loadEnv();

  if (env.SENTRY_DSN) {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      // Response payloads must never leave the system in an error report
      // (AGENT.md §5). Request bodies are not attached.
      sendDefaultPii: false,
      maxBreadcrumbs: 20,
    });
  }

  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  /**
   * Session and CSRF cookies are read on every request, so the parser runs
   * before any guard. It is NOT signed: the session cookie's value is a
   * 256-bit random token whose authority comes from matching a database row,
   * and a signature would add a second secret to rotate for no gain.
   */
  app.use(cookieParser());

  /**
   * Trust exactly ONE proxy hop — Render's load balancer (ADR-010).
   *
   * `true` would trust the whole X-Forwarded-For chain, letting any client
   * prepend an address of its choosing: the login rate limiter would then see
   * a fresh IP on every attempt, and every audit row's ip_hash would be
   * attacker-controlled. One hop takes the address the load balancer itself
   * observed.
   */
  app.getHttpAdapter().getInstance().set("trust proxy", 1);

  // Express advertises itself via X-Powered-By by default. Disclosing the
  // server stack gives an attacker a free hint about which CVEs to try, and
  // costs us nothing to remove. Next sets poweredByHeader: false for the same
  // reason on the frontends.
  app.getHttpAdapter().getInstance().disable("x-powered-by");

  // Credentials are cookies on two distinct origins (ADR-009), so the allowed
  // origin list is explicit rather than a wildcard.
  app.enableCors({
    origin: [env.PARTICIPANT_ORIGIN, env.RESEARCHER_ORIGIN],
    credentials: true,
    // The double-submit CSRF token travels in this header, so the browser has
    // to be told it is allowed on a cross-origin request (ADR-009).
    allowedHeaders: ["Content-Type", CSRF_HEADER],
  });

  app.enableShutdownHooks();

  // `PORT` is what a host assigns; `API_PORT` is the local default.
  const port = env.PORT ?? env.API_PORT;
  await app.listen(port);

  const logger = new Logger("bootstrap");
  logger.log(
    `api listening on ${String(port)} (${env.NODE_ENV}); sentry ${env.SENTRY_DSN ? "on" : "off"}`,
  );

  /**
   * Said out loud at startup, not left to be discovered.
   *
   * Without SMTP the password-reset flow still works — the link is written to
   * this log instead of sent — which is deliberate, so a team can pilot before
   * mail relaying is arranged. What must never happen is a deployment that
   * BELIEVES it is emailing reset links and is not: the only symptom would be
   * a researcher who says they never got one, weeks later, and by then nobody
   * connects the two.
   */
  if (env.SMTP_HOST === "") {
    logger.warn(
      "SMTP_HOST is empty: password-reset emails will be WRITTEN TO THIS LOG rather than sent. " +
        "Fine for local work; in production it means no researcher can recover their account " +
        "without an operator reading the log.",
    );
  }
}

void bootstrap().catch((error: unknown) => {
  console.error("api failed to start:", error);
  process.exit(1);
});
