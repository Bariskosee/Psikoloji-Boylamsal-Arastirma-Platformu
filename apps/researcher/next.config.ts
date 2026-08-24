import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * Emit a self-contained server for the container image (ADR-012).
   *
   * Next traces the files the server actually needs and writes them, with a
   * minimal `node_modules`, to `.next/standalone`. Without it a container has
   * to carry the whole workspace dependency tree — build tooling included —
   * onto a machine whose entire appeal is that it costs nothing.
   *
   * Harmless outside Docker: `next start` and `next dev` ignore it.
   */
  output: "standalone",
  // Workspace packages are consumed as source (ADR-001).
  transpilePackages: ["@lpr/ui", "@lpr/i18n", "@lpr/contracts"],
  poweredByHeader: false,
};

export default withNextIntl(nextConfig);
