import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Workspace packages are consumed as source (ADR-001).
  transpilePackages: ["@lpr/ui", "@lpr/i18n", "@lpr/contracts"],
  poweredByHeader: false,
};

export default withNextIntl(nextConfig);
