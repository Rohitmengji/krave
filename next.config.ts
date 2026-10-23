import type { NextConfig } from "next";
import { securityHeaders } from "./src/lib/securityHeaders";

const imageHosts = [
  { protocol: "https", hostname: "b.zmtcdn.com" },
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
        headers: securityHeaders({ isDev: process.env.NODE_ENV === "development", imageHosts }),
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
