import { defineConfig } from "vitest/config";

/**
 * Unit lane. Integration tests need a real PostgreSQL and are excluded here so
 * `pnpm test` stays runnable without any infrastructure — the same split the
 * db package uses.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "src/**/*.integration.test.ts",
      // The load lane needs a database and takes minutes. `pnpm test` must stay
      // the fast one, or it stops being run before every commit.
      "src/load/**",
    ],
  },
});
