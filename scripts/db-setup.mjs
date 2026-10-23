/**
 * Creates the Krave schema and checks the connection.
 *
 *   node --env-file=.env.local scripts/db-setup.mjs
 *
 * Safe to run repeatedly: every statement is CREATE IF NOT EXISTS or CREATE OR REPLACE.
 * Pass --url=... to target a different database, for example the local test one.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import pg from "pg";

const urlArg = process.argv.find((arg) => arg.startsWith("--url="));
// --test reads from the loaded env file; a shell would expand $TEST_DATABASE_URL
// before --env-file had defined it.
const useTest = process.argv.includes("--test");
const url = urlArg
  ? urlArg.slice("--url=".length)
  : useTest
    ? process.env.TEST_DATABASE_URL
    : process.env.DATABASE_URL;

if (!url) {
  console.error(
    "No connection string. Either copy .env.example to .env.local and set DATABASE_URL,\n" +
      "then run:  node --env-file=.env.local scripts/db-setup.mjs\n" +
      "or pass one explicitly:  node scripts/db-setup.mjs --url=postgresql://..."
  );
  process.exit(1);
}

// --reset empties every table, so it is only allowed on the test branch and never on the
// same host as the application database.
const reset = process.argv.includes("--reset");
if (reset) {
  const appHost = process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).host : null;
  if (!useTest || (appHost && new URL(url).host === appHost)) {
    console.error("Refusing --reset: it is only allowed with --test, on a host other than DATABASE_URL.");
    process.exit(1);
  }
}

/** Reads the schema out of the TypeScript module without needing a build step. */
function loadSchema() {
  const source = readFileSync(
    path.join(process.cwd(), "src", "lib", "server", "pgSchema.ts"),
    "utf8"
  );
  const opening = source.indexOf("export const PG_SCHEMA = `");
  if (opening === -1) throw new Error("Could not find PG_SCHEMA in pgSchema.ts");
  const start = source.indexOf("`", opening) + 1;
  const end = source.indexOf("\n`;", start);
  if (end === -1) throw new Error("Could not find the end of PG_SCHEMA");
  return source.slice(start, end);
}

function describe(connectionString) {
  try {
    const parsed = new URL(connectionString);
    // Never print the password.
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return "(unparseable connection string)";
  }
}

const isLocal = url.includes("localhost") || url.includes("127.0.0.1");

/** See pinSslMode in src/lib/server/pg.ts: `require` weakens in pg 9, so pin verify-full. */
function pinSslMode(connectionString) {
  if (isLocal) return connectionString;
  try {
    const parsed = new URL(connectionString);
    parsed.searchParams.set("sslmode", "verify-full");
    return parsed.toString();
  } catch {
    return connectionString;
  }
}

const client = new pg.Client({
  connectionString: pinSslMode(url),
  ssl: isLocal ? false : { rejectUnauthorized: true },
  connectionTimeoutMillis: 20_000,
});

try {
  console.info(`Connecting to ${describe(url)} ...`);
  await client.connect();

  const { rows: version } = await client.query("SELECT version()");
  console.info(`Connected. ${String(version[0].version).split(",")[0]}`);

  await client.query(loadSchema());
  console.info("Schema applied.");

  if (reset) {
    // audit_log is append-only by trigger, TRUNCATE included, so it is left as it is.
    const { rows: wipeable } = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'audit_log'`
    );
    const names = wipeable.map((row) => `"${row.table_name}"`).join(", ");
    await client.query(`TRUNCATE ${names} RESTART IDENTITY CASCADE`);
    console.info(`Reset ${wipeable.length} tables on the test branch.`);
  }

  const { rows: tables } = await client.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' ORDER BY table_name`
  );
  console.info(`${tables.length} tables: ${tables.map((row) => row.table_name).join(", ")}`);

  // Proves the append-only trigger survived the port, rather than assuming it did.
  await client.query(
    `INSERT INTO audit_log (actor_id, action, subject, detail, at)
     VALUES ('setup-check', 'SETUP_VERIFY', 'setup', 'connection check', $1)`,
    [new Date().toISOString()]
  );
  let appendOnlyHolds = false;
  try {
    await client.query("UPDATE audit_log SET detail = 'tampered' WHERE subject = 'setup'");
  } catch (error) {
    appendOnlyHolds = /append-only/i.test(error.message);
  }
  console.info(
    appendOnlyHolds
      ? "Append-only audit log: enforced."
      : "WARNING: audit_log accepted an UPDATE. The trigger did not apply."
  );

  if (!appendOnlyHolds) process.exitCode = 1;
} catch (error) {
  console.error(`Failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
