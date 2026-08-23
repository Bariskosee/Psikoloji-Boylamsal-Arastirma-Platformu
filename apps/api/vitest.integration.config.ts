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
 * ── Why the files are serialised, twice over ────────────────────────────────
 * These tests share one database and every file truncates it in `beforeEach`.
 * Two files running at once would delete each other's fixtures mid-assertion,
 * and the resulting failures read as authorization bugs rather than as what
 * they are.
 *
 * `singleThread` already puts every file in one worker. `fileParallelism:
 * false` states the requirement directly rather than leaving it as a
 * side-effect of a pool option — the two are belt and braces, and `apps/worker`
 * uses the latter for the same reason.
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
    fileParallelism: false,
  },
});
