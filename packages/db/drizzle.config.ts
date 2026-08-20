import { config as loadDotenv } from "dotenv";
import type { Config } from "drizzle-kit";

/**
 * Migration tooling configuration.
 *
 * ── Why this loads .env itself ───────────────────────────────────────────────
 * Every long-running process reads the repo-root `.env` through its own
 * `config/load-env.ts`. drizzle-kit is not one of those processes: it is a CLI
 * that only sees the shell's environment. So `pnpm --filter=@lpr/db migrate:up`
 * — the command CONTRIBUTING.md tells a new developer to run — used to ignore
 * `.env` entirely and silently fall back to a hard-coded connection string.
 *
 * Silently is the problem. The fallback is a plausible local URL, so if
 * anything else is listening on 5432 the migrations apply cleanly to THE WRONG
 * DATABASE and report success. Loading the same file the applications load, and
 * refusing to guess when it is absent, makes the target explicit.
 */
loadDotenv({ path: [".env", "../../.env"], quiet: true });

const url = process.env["DATABASE_URL"];

if (!url) {
  throw new Error(
    "DATABASE_URL is not set. Copy .env.example to .env at the repository root, " +
      "or export DATABASE_URL for this command. Refusing to guess a connection " +
      "string: a wrong guess migrates a database you did not mean to touch.",
  );
}

export default {
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
} satisfies Config;
