import { defineConfig } from "vitest/config";

/** Integration lane. Requires a reachable PostgreSQL at DATABASE_URL. */
export default defineConfig({
  test: {
    include: ["src/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
