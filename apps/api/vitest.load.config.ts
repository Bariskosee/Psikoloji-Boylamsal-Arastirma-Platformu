import { config as loadDotenv } from "dotenv";
import swc from "unplugin-swc";
import { defineConfig } from "vitest/config";

loadDotenv({ path: new URL("../../.env", import.meta.url).pathname });

/**
 * The load lane. Run deliberately, never in CI.
 *
 * Separate from the integration config so that `pnpm test:integration` cannot
 * accidentally spend four minutes measuring throughput, and so a timing
 * measurement never becomes a pass/fail gate on a shared runner — where it
 * would be a flaky test with extra steps.
 */
/**
 * The enrollment limiter is lifted for this lane only.
 *
 * It is 60 an hour from one address, and every request here comes from
 * loopback — so the limiter would refuse the sixty-first participant and the
 * run would measure the rate limiter rather than the platform. The limiter has
 * its own test in `participant.integration.test.ts`; this lane exists to
 * measure what happens once people are through the door.
 */
process.env["ENROLL_RATE_LIMIT_MAX"] = "100000";

export default defineConfig({
  plugins: [swc.vite({ module: { type: "es6" } })],
  test: {
    include: ["src/load/*.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    fileParallelism: false,
  },
});
