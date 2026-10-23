import { Pool } from "pg";
import { closePool, pinSslMode, run, replacePool } from "@/lib/server/pg";
import { PG_SCHEMA, PG_TABLES } from "@/lib/server/pgSchema";

/**
 * Points the stores at the Neon test branch and wipes it between cases.
 *
 * Tests need a real Postgres because the stores now rely on behaviour SQLite does not
 * have: advisory locks, FOR UPDATE, partial indexes, statement triggers.
 */

let pool: Pool | null = null;

function testUrl(): string | null {
  return process.env.TEST_DATABASE_URL ?? null;
}

export const hasTestDatabase = Boolean(testUrl());

/**
 * Refuses to run against the application database.
 *
 * resetTestDatabase truncates every table, so pointing it at production would erase it.
 */
function assertNotProduction(url: string): void {
  const appUrl = process.env.DATABASE_URL;
  if (appUrl && new URL(url).host === new URL(appUrl).host) {
    throw new Error(
      "TEST_DATABASE_URL points at the same host as DATABASE_URL. Use a separate Neon branch: the suite truncates every table."
    );
  }
}

export async function startTestDatabase(): Promise<void> {
  const url = testUrl();
  if (!url) throw new Error("TEST_DATABASE_URL is not set.");
  assertNotProduction(url);

  pool = new Pool({
    connectionString: pinSslMode(url),
    ssl: url.includes("localhost") ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 20_000,
    max: 4,
  });
  replacePool(pool);
  await run(PG_SCHEMA);
}

export async function stopTestDatabase(): Promise<void> {
  await closePool();
  pool = null;
}

/**
 * Empties every table between cases.
 *
 * audit_log is excluded because it is append-only by trigger — including TRUNCATE. Tests
 * that read it scope their assertions to their own ids instead.
 */
export async function resetTestDatabase(): Promise<void> {
  const wipeable = PG_TABLES.filter((table) => table !== "audit_log");
  await run(`TRUNCATE ${wipeable.join(", ")} RESTART IDENTITY CASCADE`);
}
