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

  /**
   * This worker instance's identity in `research.system_heartbeats` (ADR-005).
   *
   * Must be STABLE ACROSS RESTARTS for a given instance, and distinct between
   * instances. Both halves matter: an id that changes on restart leaves a trail
   * of orphaned rows that are permanently stale and therefore permanently
   * alerting, while an id shared by two replicas makes them overwrite each
   * other's heartbeat, so either one going down is invisible.
   *
   * Defaulted from the hostname, which is what a container platform assigns per
   * instance. Set explicitly wherever the hostname is random per start.
   */
  WORKER_ID: z.string().min(1).optional(),

  /**
   * VAPID (ADR-006, Phase 9). The worker is the only process that SENDS, so it
   * is the only process that needs the private key.
   *
   * Optional, and the optionality is the documented degraded mode: a deployment
   * with no keys runs the whole study without push. The worker then uses the
   * recording transport, which still writes `notification_attempts` rows — so a
   * researcher can see that outreach was attempted and that nothing left the
   * building, rather than seeing silence and having to guess why.
   */
  VAPID_PUBLIC_KEY: z.string().optional().default(""),
  VAPID_PRIVATE_KEY: z.string().optional().default(""),
  /** A contact the push service can reach the operator at. */
  VAPID_SUBJECT: z.string().optional().default("mailto:ops@example.invalid"),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

/**
 * Is Web Push configured here?
 *
 * The API asks the same question of its own environment and refuses to boot on
 * half a pair. The worker deliberately does NOT refuse: it has four sweepers to
 * run, and the entire scheduling guarantee rests on this process staying up
 * (ADR-005, ADR-010). A misconfigured key pair must degrade push, not stop the
 * clock.
 */
export function isPushConfigured(env: WorkerEnv): boolean {
  return env.VAPID_PUBLIC_KEY.length > 0 && env.VAPID_PRIVATE_KEY.length > 0;
}

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
