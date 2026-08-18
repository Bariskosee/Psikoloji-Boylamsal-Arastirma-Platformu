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

  /**
   * Keys the salted IP hashes written to sessions and audit rows (STRUCTURE.md
   * §11.5), so a leaked audit export cannot be reversed into a list of
   * addresses. Rotating it makes historic hashes uncorrelatable, which is a
   * feature rather than a defect.
   *
   * Required with no default: a session secret that falls back to a constant is
   * not a secret, and the failure would be silent.
   */
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),

  /**
   * Absolute session lifetime. A session ends after this long no matter how
   * actively it is used.
   */
  SESSION_ABSOLUTE_TTL_HOURS: z.coerce.number().int().positive().max(168).default(12),

  /**
   * Idle timeout. A session unused for this long is rejected on its next use.
   * Shorter than the absolute lifetime, and the reason a shared dashboard left
   * open in a lab does not stay logged in overnight.
   */
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().max(1440).default(120),

  /**
   * Secure cookies. Defaults to on outside development — a session cookie sent
   * over plain HTTP is a session cookie on the network. Overridable only so a
   * local http://localhost session works at all.
   */
  COOKIE_SECURE: z.enum(["true", "false"]).optional(),

  /** Login attempts per window, per email and per IP (STRUCTURE.md §11.5). */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  LOGIN_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),

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

/**
 * Should cookies carry the Secure attribute?
 *
 * On outside development, always. Inside development it is off by default:
 * Safari refuses Secure cookies over `http://localhost`, so defaulting it on
 * would make local login fail in one browser and work in the others — the kind
 * of environment-specific breakage that costs an afternoon to diagnose.
 * Setting COOKIE_SECURE explicitly always wins.
 */
export function shouldUseSecureCookies(env: Env): boolean {
  if (env.COOKIE_SECURE !== undefined) return env.COOKIE_SECURE === "true";
  return env.NODE_ENV !== "development";
}
