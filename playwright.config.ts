import { existsSync } from "node:fs";
import { defineConfig, devices } from "@playwright/test";
import { MAIL_SINK_PORT } from "./e2e/mailbox";

const PORT = Number(process.env.KRAVE_E2E_PORT || 3099);
const BASE_URL = `http://127.0.0.1:${PORT}`;

// Locally the connection strings live in .env.local; CI supplies them as real env vars.
if (existsSync(".env.local")) process.loadEnvFile(".env.local");

/**
 * The suite registers accounts and places orders, and resets its database first, so it must
 * never reach the application database. Next would otherwise read DATABASE_URL from
 * .env.local and point the test server at production.
 */
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!TEST_DATABASE_URL) {
  throw new Error("TEST_DATABASE_URL is not set. E2E needs its own Neon branch.");
}
// Pooled and direct hosts of one Neon endpoint differ only by "-pooler".
const endpoint = (value: string) => new URL(value).host.replace("-pooler.", ".");
const appEndpoints = [process.env.DATABASE_URL, process.env.DATABASE_URL_UNPOOLED]
  .filter((value): value is string => Boolean(value))
  .map(endpoint);
if (appEndpoints.includes(endpoint(TEST_DATABASE_URL))) {
  throw new Error("TEST_DATABASE_URL points at the application database. Refusing to run E2E.");
}

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
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
    command: `npx next start --port ${PORT}`,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      // Explicit, so it wins over the production DATABASE_URL Next would load from .env.local.
      DATABASE_URL: TEST_DATABASE_URL,
      // Price locks are off without this, so the suite would silently skip covering them.
      KRAVE_QUOTE_SECRET: "e2e-only-quote-secret",
      // One account is staff everywhere. Deliberately not KRAVE_OPEN_STAFF, so the
      // suite still proves that ordinary accounts are refused.
      KRAVE_STAFF_EMAILS: "e2e-staff@krave.test",
      // Mail goes to the suite's own SMTP sink (e2e/global-setup.ts). The login is blanked
      // explicitly: an empty value beats .env.local, whose real account must never send here.
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(MAIL_SINK_PORT),
      SMTP_USER: "",
      SMTP_PASS: "",
      EMAIL_FROM: "KRAVE <no-reply@krave.test>",
      KRAVE_PUBLIC_URL: BASE_URL,
      // Paid and external services stay off, so a run can never bill the AI provider or
      // write to a real bucket, and the suite covers the unconfigured states owners see.
      DATABASE_URL_UNPOOLED: "",
      OPENAI_API_KEY: "",
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      AWS_ENDPOINT_URL_S3: "",
    },
  },
});
