import { Pool, type PoolClient, type QueryResultRow } from "pg";

/**
 * Postgres access for Neon and for a local Postgres in tests.
 *
 * Uses the standard wire protocol rather than Neon's own driver, so the same code runs
 * against Neon and against a local server with no second code path.
 */

let pool: Pool | null = null;

function connectionString(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.");
  }
  return url;
}

/**
 * Pins `sslmode=verify-full`.
 *
 * Neon hands out `sslmode=require`, which pg currently treats as verify-full but will
 * downgrade to libpq semantics (no certificate verification) in pg 9. Being explicit
 * means a driver upgrade cannot silently weaken the connection.
 */
export function pinSslMode(url: string): string {
  if (isLocal(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.searchParams.set("sslmode", "verify-full");
    return parsed.toString();
  } catch {
    return url;
  }
}

function isLocal(url: string): boolean {
  return url.includes("localhost") || url.includes("127.0.0.1");
}

export function getPool(): Pool {
  if (pool) return pool;

  const url = connectionString();
  pool = new Pool({
    connectionString: pinSslMode(url),
    // Neon terminates TLS at its proxy with a public CA, so verification stays on.
    // A local server over loopback has no TLS at all.
    ssl: isLocal(url) ? false : { rejectUnauthorized: true },
    // Neon scales to zero; a cold start costs a few seconds on the first query.
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 30_000,
    max: 10,
  });

  // Without this, a dropped Neon connection surfaces as an unhandled rejection that
  // takes the process down instead of being retried on the next query.
  pool.on("error", (error) => {
    console.error("Postgres pool error:", error.message);
  });

  return pool;
}

/** Replaces the pool, for tests that run against a local server. */
export function replacePool(replacement: Pool): void {
  pool = replacement;
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

export async function rows<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

/** First row, or undefined. Mirrors how the SQLite layer's `get` was used. */
export async function one<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T | undefined> {
  const result = await getPool().query<T>(text, params);
  return result.rows[0];
}

/** Number of rows affected, for guarded updates that must detect a no-op. */
export async function run(text: string, params: unknown[] = []): Promise<number> {
  const result = await getPool().query(text, params);
  return result.rowCount ?? 0;
}

/**
 * Runs a unit of work in a transaction on one connection.
 *
 * Reads and writes that must agree with each other have to share a connection; pooled
 * queries can otherwise land on different sessions and interleave.
 */
export async function transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
