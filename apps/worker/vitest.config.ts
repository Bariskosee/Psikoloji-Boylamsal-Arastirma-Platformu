import { defineConfig } from "vitest/config";

/**
 * Unit lane. Integration tests need a real PostgreSQL and are excluded here so
 * `pnpm test` stays runnable without any infrastructure.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "src/**/*.integration.test.ts"],
  },
});
