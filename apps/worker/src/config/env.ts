import { z } from "zod";

const workerEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  SENTRY_DSN: z.string().optional().default(""),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  /**
   * Reconciliation sweep interval (ADR-005).
   *
   * This is the upper bound on how long the system takes to recover correct
   * scheduling state after an outage, a lost job, or a database restore.
   * Raising it directly widens that window, so it is capped.
   */
  SWEEP_INTERVAL_SECONDS: z.coerce.number().int().min(10).max(300).default(60),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export function loadWorkerEnv(source: NodeJS.ProcessEnv = process.env): WorkerEnv {
  const parsed = workerEnvSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid worker environment:\n${detail}`);
  }
  return parsed.data;
}
