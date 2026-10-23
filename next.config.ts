import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/securityHeaders";

const imageHosts = [
  { protocol: "https", hostname: "images.unsplash.com" },
] as const;

const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    remotePatterns: [...imageHosts],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders({
          isDev: process.env.NODE_ENV === "development",
          imageHosts,
          // Read at build time: changing the storage endpoint needs a redeploy.
          storageEndpoint: process.env.AWS_ENDPOINT_URL_S3,
        }),
      },
      {
        // The worker itself is never cached, so an updated shell always reaches the device.
        source: "/sw.js",
        headers: [
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Security-Policy", value: "default-src 'self'; script-src 'self'" },
        ],
      },
    ];
  },
};

export default nextConfig;
