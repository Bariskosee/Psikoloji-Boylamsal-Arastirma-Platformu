import { z } from "zod";

/**
 * Environment validation.
 *
 * The process refuses to start on invalid configuration rather than failing
 * later in a request. A scheduling system that boots with a wrong database URL
 * and only discovers it at the first reminder is worse than one that never
 * boots.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  API_PORT: z.coerce.number().int().positive().default(3001),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  PARTICIPANT_ORIGIN: z.string().url().default("http://localhost:3000"),
  RESEARCHER_ORIGIN: z.string().url().default("http://localhost:3002"),

  // Empty disables Sentry, which is the correct default for local development.
  SENTRY_DSN: z.string().optional().default(""),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(
      `Invalid environment configuration:\n${detail}\n\nCopy .env.example to .env and fill it in.`,
    );
  }

  return parsed.data;
}
