import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  distDir: process.env.WORKBENCH_DIST_DIR ?? ".next",
  serverExternalPackages: ["better-sqlite3"],
  poweredByHeader: false,
  experimental: { serverActions: { bodySizeLimit: "1mb" } },
  async headers() {
    return [{ source: "/:path*", headers: [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "X-Frame-Options", value: "DENY" },
      { key: "Referrer-Policy", value: "same-origin" },
      { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'" },
      { key: "Cache-Control", value: "private, no-store" },
    ] }, { source: "/api/workbench/attachments/:path*", headers: [
      { key: "Content-Security-Policy", value: "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" },
    ] }, { source: "/api/workbench/catalog", headers: [
      { key: "Content-Security-Policy", value: "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" },
    ] }, { source: "/api/workbench/market", headers: [
      { key: "Content-Security-Policy", value: "sandbox; default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" },
    ] }];
  },
};

export default nextConfig;
