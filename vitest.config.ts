import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/tests/**/*.test.ts"],
    // The database suites share one Postgres branch and truncate it between cases, so
    // files running side by side would wipe each other's rows and deadlock on schema DDL.
    fileParallelism: false,
    // Each query is a network round trip to the Neon branch, and the throttle suites make
    // dozens of sign-in attempts. A timed-out test keeps running and corrupts the next one.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
