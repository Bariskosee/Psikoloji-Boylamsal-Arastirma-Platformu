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

  /**
   * VAPID (ADR-006). Optional, and the optionality is a feature: a deployment
   * with no keys runs the whole study without push, which is the documented
   * degraded mode rather than a broken one. The API advertises the PUBLIC key
   * to participants; without it the client is told push is unavailable here and
   * stops offering to enable it.
   *
   * The PRIVATE key never leaves this process and appears in no response. It is
   * read here so that the process refuses to start on a half-configured pair —
   * a public key with no private one produces subscriptions that can never be
   * sent to, and nothing would report it until Phase 9.
   */
  VAPID_PUBLIC_KEY: z.string().optional().default(""),
  VAPID_PRIVATE_KEY: z.string().optional().default(""),
  VAPID_SUBJECT: z.string().optional().default(""),

  /** Push subscription registrations per hour, per participant (STRUCTURE.md §11.5). */
  PUSH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  /** Login attempts per window, per email and per IP (STRUCTURE.md §11.5). */
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),
  LOGIN_RATE_LIMIT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),

  /**
   * Outbound email, used only for researcher password resets (Phase 12).
   *
   * ── Why an empty SMTP host is a supported configuration ─────────────────
   * A research team may run a pilot before they have institutional mail
   * relaying arranged. With no host configured the API still accepts reset
   * requests and still mints tokens, and the message is written to the log
   * instead of sent — so the flow is testable end to end and an administrator
   * can read the link out of the log if they must.
   *
   * It is NOT a silent fallback in production: `main.ts` logs a warning at
   * startup when the host is empty, in the same way the VAPID keys do, because
   * a deployment that believes it is sending reset emails and is not would
   * only discover it from a researcher who never received one.
   */
  SMTP_HOST: z.string().optional().default(""),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASSWORD: z.string().optional().default(""),
  /** STARTTLS on 587 is the default; set true for implicit TLS on 465. */
  SMTP_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
  /** The From address. Required in substance whenever SMTP_HOST is set. */
  MAIL_FROM: z.string().optional().default(""),

  /** Password reset requests per hour, per account and per IP. */
  PASSWORD_RESET_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(5),

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

  const env = parsed.data;

  /**
   * Half a VAPID pair is worse than none.
   *
   * With a public key and no private one, participants subscribe successfully,
   * the rows are stored, the settings screen says notifications are on — and
   * every send fails from Phase 9 onward. Nothing in the participant's
   * experience contradicts it, so the failure is invisible until compliance
   * data comes back thin. Refusing to boot is the only signal that arrives in
   * time.
   */
  const configured = [env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY].filter(
    (value) => value.length > 0,
  ).length;
  if (configured === 1) {
    throw new Error(
      "Invalid environment configuration:\n  VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be " +
        "set together, or both left empty.\n\nWith only one of them, participants subscribe " +
        "successfully and every send fails silently. Generate a pair with " +
        "`pnpm dlx web-push generate-vapid-keys`, or leave both empty to run without push.",
    );
  }

  return env;
}

/**
 * Is Web Push configured on this deployment?
 *
 * The one question the participant API answers about VAPID. Everything else
 * about the key pair stays inside the process (ADR-006).
 */
export function isPushConfigured(env: Env): boolean {
  return env.VAPID_PUBLIC_KEY.length > 0 && env.VAPID_PRIVATE_KEY.length > 0;
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
