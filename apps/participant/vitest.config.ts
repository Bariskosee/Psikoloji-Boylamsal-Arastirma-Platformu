import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Unit and component tests for the participant application.
 *
 * jsdom rather than a real browser. What matters most here — the push
 * availability matrix in `lib/push-availability.ts` — is a pure function of
 * facts the caller collected, so no browser engine adds coverage. The one thing
 * a real device WOULD tell us, whether Safari on an iPhone behaves as the matrix
 * predicts, is not something jsdom can answer either; PLAN.md Phase 8 puts that
 * in a manual matrix on real hardware, which is the honest place for it.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "**/.next/**"],
  },
});
