import { config as loadDotenv } from "dotenv";
import { defineConfig } from "vitest/config";

// Load the repo-root .env so `pnpm test:integration` works locally straight
// after `cp .env.example .env`, as CONTRIBUTING documents. CI provides
// DATABASE_URL through the job environment instead, and real environment
// variables always win over the file.
loadDotenv({ path: new URL("../../.env", import.meta.url).pathname });

/**
 * Integration lane. Requires a reachable PostgreSQL at DATABASE_URL.
 *
 * These tests take advisory locks and open concurrent transactions on purpose —
 * `SKIP LOCKED`, `FOR UPDATE` and `pg_try_advisory_lock` have no faithful
 * in-memory equivalent, so a fake here would test the wrong thing entirely
 * (STRUCTURE.md §16).
 */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Sequential: several of these assert what happens when two connections
    // contend for the same lock or row. Parallel files would contend with each
    // other instead, and the failures would be indistinguishable.
    fileParallelism: false,
  },
});
