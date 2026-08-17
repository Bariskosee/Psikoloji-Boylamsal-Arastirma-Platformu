import { config as loadDotenv } from "dotenv";
import { defineConfig } from "vitest/config";

// Load the repo-root .env so `pnpm test:integration` works locally straight
// after `cp .env.example .env`, as CONTRIBUTING documents. CI provides
// DATABASE_URL through the job environment instead, and real environment
// variables always win over the file.
loadDotenv({ path: new URL("../../.env", import.meta.url).pathname });

/** Integration lane. Requires a reachable PostgreSQL at DATABASE_URL. */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
