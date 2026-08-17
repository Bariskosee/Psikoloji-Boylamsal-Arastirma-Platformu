import type { Config } from "drizzle-kit";

/**
 * Migration tooling configuration.
 *
 * Phase 0 configures the workflow; it authors no migrations. See PLAN.md.
 */
export default {
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://lpr:lpr_local_dev_only@localhost:5432/lpr",
  },
  strict: true,
  verbose: true,
} satisfies Config;
