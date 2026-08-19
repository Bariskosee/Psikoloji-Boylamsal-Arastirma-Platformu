import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Component tests for the dashboard.
 *
 * jsdom rather than a real browser: what these tests assert is what React puts
 * in the DOM — chiefly that researcher-entered text arrives as TEXT and never
 * as markup (PLAN.md Phase 3, "Security considerations"). That is a property
 * of the render, not of a browser engine, so a headless browser would add
 * minutes to CI for no additional coverage.
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
