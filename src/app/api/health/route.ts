import { NextResponse } from "next/server";
import { logServerError } from "@/lib/server/log";
import { one } from "@/lib/server/pg";
import { restaurantStorageConfigured } from "@/lib/server/restaurantStorage";

export const dynamic = "force-dynamic";

// Under Vercel's function limit and above a Neon cold start, so a suspended compute still
// reports healthy while a dead one is reported within a few seconds.
const DATABASE_TIMEOUT_MS = 8_000;

type Check = { status: "ok" } | { status: "down"; reason: string };

async function checkDatabase(): Promise<{ database: Check; schema: Check }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("Database health check timed out.")), DATABASE_TIMEOUT_MS);
  });
  try {
    // One round trip proves connectivity and that the latest schema was applied.
    const row = await Promise.race([
      one<{ managed: string | null; orders: string | null }>(
        "SELECT to_regclass('public.managed_restaurants')::text AS managed, to_regclass('public.orders')::text AS orders"
      ),
      timeout,
    ]);
    const schemaReady = Boolean(row?.managed && row?.orders);
    return {
      database: { status: "ok" },
      schema: schemaReady
        ? { status: "ok" }
        : { status: "down", reason: "Schema is missing tables. Run npm run db:setup." },
    };
  } catch (error) {
    logServerError("health_database_failed", error);
    const reason = error instanceof Error && /timed out/.test(error.message) ? "timeout" : "unreachable";
    return {
      database: { status: "down", reason },
      schema: { status: "down", reason: "Database unavailable." },
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Health for uptime monitors. Only the database decides the status code: the optional
 * integrations degrade single features (uploads, AI import, email) and are reported as
 * configured or not, never probed, so a check cannot spend AI credits or storage requests.
 */
export async function GET() {
  const { database, schema } = await checkDatabase();
  const healthy = database.status === "ok" && schema.status === "ok";
  return NextResponse.json(
    {
      status: healthy ? "ok" : "degraded",
      checks: { database, schema },
      features: {
        uploads: restaurantStorageConfigured(),
        menuImport: Boolean(process.env.OPENAI_API_KEY),
        email: Boolean(process.env.SMTP_HOST?.trim()),
      },
      time: new Date().toISOString(),
    },
    { status: healthy ? 200 : 503, headers: { "Cache-Control": "no-store" } }
  );
}
