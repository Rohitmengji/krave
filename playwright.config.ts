import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.KRAVE_E2E_PORT || 3099);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // Each spec drives a shared database and a shared terminal, so they must not interleave.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? "line" : [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // A throwaway database per run, so a passing suite never depends on earlier state.
    command: `rm -rf .data-e2e && npx next start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      KRAVE_DB_PATH: ".data-e2e/krave.db",
      // Price locks are off without this, so the suite would silently skip covering them.
      KRAVE_QUOTE_SECRET: "e2e-only-quote-secret",
    },
  },
});
