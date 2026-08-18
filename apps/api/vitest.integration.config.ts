import { config as loadDotenv } from "dotenv";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

// Load the repo-root .env so `pnpm test:integration` works locally straight
// after `cp .env.example .env`. CI provides DATABASE_URL through the job
// environment instead, and real environment variables always win over the file.
loadDotenv({ path: new URL("../../.env", import.meta.url).pathname });

/**
 * Integration lane. Requires a reachable PostgreSQL with migrations applied.
 *
 * ── Why SWC and not Vitest's default esbuild ────────────────────────────────
 * NestJS resolves constructor injection through `emitDecoratorMetadata`, and
 * **esbuild does not implement it**. Under the default transform every
 * `constructor(private readonly x: Service)` loses its type metadata and DI
 * fails at module construction with "Nest can't resolve dependencies" —
 * pointing at the guard rather than at the build tool, which makes it a
 * genuinely confusing failure. SWC implements the metadata emit, so the same
 * code that `tsc` compiles for production is what these tests exercise.
 *
 * `singleThread` because these tests share one database: parallel files would
 * truncate each other's fixtures mid-assertion, producing failures that look
 * like authorization bugs and are not.
 */
export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    include: ["src/**/*.integration.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
  },
});
