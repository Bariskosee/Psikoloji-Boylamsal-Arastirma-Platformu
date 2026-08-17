import "reflect-metadata";
import * as Sentry from "@sentry/node";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
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

  // Credentials are cookies on two distinct origins (ADR-009), so the allowed
  // origin list is explicit rather than a wildcard.
  app.enableCors({
    origin: [env.PARTICIPANT_ORIGIN, env.RESEARCHER_ORIGIN],
    credentials: true,
  });

  app.enableShutdownHooks();

  await app.listen(env.API_PORT);
  new Logger("bootstrap").log(
    `api listening on ${env.API_PORT} (${env.NODE_ENV}); sentry ${env.SENTRY_DSN ? "on" : "off"}`,
  );
}

void bootstrap().catch((error: unknown) => {
  console.error("api failed to start:", error);
  process.exit(1);
});
