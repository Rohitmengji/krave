import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/webroutes/[...slug]/route";
import { createDemoOrder, DEMO_PAYMENT_METHODS } from "@/lib/checkout";
import { closePool, one, run } from "@/lib/server/pg";
import {
  createSession,
  LOGIN_WINDOW_MINUTES,
  MAX_GUEST_ORDERS_PER_CLIENT,
  MAX_SIGNUPS_PER_CLIENT,
  registerUser,
  SESSION_COOKIE,
} from "@/lib/server/auth";
import {
  advanceOrderStage,
  deleteOrder,
  listOrders,
  saveOrder,
} from "@/lib/server/accountStore";
import {
  hasTestDatabase,
  resetTestDatabase,
  startTestDatabase,
  stopTestDatabase,
} from "./support/testDb";

// Demo orders are priced from the legacy fictional catalog, which the app no longer ships.
vi.mock("@/data/zomatoReconstructedData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/zomatoReconstructedData")>()),
  ...(await import("./support/legacyCatalog")).LEGACY_CATALOG,
}));

const CREDENTIALS = { email: "launch@krave.test", password: "correct-horse-battery" };
const CHECKOUT = {
  items: [{ itemId: "ctl_820099425", quantity: 1, optionIds: ["opt_500g"] }],
  addressId: "addr_cp_514",
  paymentMethod: DEMO_PAYMENT_METHODS[0],
  couponCode: null,
  isGoldMember: false,
  riderTip: 0,
};

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  const request = new NextRequest(`http://localhost/api/webroutes/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
  return POST(request, { params: Promise.resolve({ slug: path.split("/") }) });
}

async function count(table: string): Promise<number> {
  return Number((await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`))?.n);
}

/** Records `n` earlier attempts for a key, `minutesAgo` in the past. */
async function seedAttempts(key: string, n: number, minutesAgo = 1): Promise<void> {
  const at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
  await run(
    `INSERT INTO login_attempts (attempt_key, attempted_at, succeeded)
     SELECT $1, $2, 0 FROM generate_series(1, $3)`,
    [key, at, n]
  );
}

// Runs first and without a database: it removes the pool on purpose.
describe("server faults on a public deployment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("answers a database or config failure with a generic 500 and logs the cause", async () => {
    await closePool();
    vi.stubEnv("DATABASE_URL", "");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post("order/cart", CHECKOUT);
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text).message).toMatch(/on our side/i);
    expect(text).not.toMatch(/DATABASE_URL|\.env|neon\.tech/i);
    // The operator still sees why.
    expect(String(logged.mock.calls[0]?.[1]?.cause)).toMatch(/DATABASE_URL is not set/);
  });

  it("still shows a customer their own validation message", async () => {
    const response = await post("order/cart", { ...CHECKOUT, items: [] });
    expect(response.status).toBe(400);
    expect((await response.json()).message).not.toMatch(/on our side/i);
  });
});

describe.skipIf(!hasTestDatabase)("launch hardening (Postgres)", () => {
  beforeAll(async () => {
    await startTestDatabase();
  });

  afterAll(async () => {
    await stopTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("lets concurrent retries of one checkout create one order and one kitchen ticket", async () => {
    const user = await registerUser(CREDENTIALS);
    const { token } = await createSession(user.id);
    const headers = {
      cookie: `${SESSION_COOKIE}=${token}`,
      "Idempotency-Key": "launch-retry-key",
    };

    // Open every pooled connection first. Otherwise the first request runs on the warm one
    // and finishes before the others connect, and the race never happens.
    await Promise.all(Array.from({ length: 4 }, () => one("SELECT pg_sleep(0.1)")));

    // The same intent sent four times at once, as a flaky network plus retries would.
    const responses = await Promise.all(
      Array.from({ length: 4 }, () => post("order/makeOrder", CHECKOUT, headers))
    );
    const bodies = await Promise.all(responses.map((response) => response.json()));

    expect(responses.map((response) => response.status).every((status) => status < 300)).toBe(true);
    expect(bodies.filter((body) => body.replayed)).toHaveLength(3);
    expect(new Set(bodies.map((body) => body.order.orderId)).size).toBe(1);
    expect(await count("orders")).toBe(1);
    expect(await count("delivery_tickets")).toBe(1);
    expect(await count("notifications")).toBe(1);
  });

  it("only moves tracking forward, so a late update cannot reopen cancellation", async () => {
    const user = await registerUser(CREDENTIALS);
    const order = createDemoOrder(CHECKOUT);
    await saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });

    await advanceOrderStage(user.id, order.orderId, "ARRIVED");
    // Out-of-order and backwards updates are ignored rather than applied.
    await advanceOrderStage(user.id, order.orderId, "OUT_FOR_DELIVERY");
    await advanceOrderStage(user.id, order.orderId, "ORDER_CONFIRMED");

    expect((await listOrders(user.id))[0].stage).toBe("ARRIVED");
    await expect(deleteOrder(user.id, order.orderId)).rejects.toThrow(/kitchen/i);
    await expect(advanceOrderStage(user.id, "ord_not_mine", "ARRIVED")).rejects.toThrow();
  });

  it("caps new accounts per network address, and forgets attempts once they age out", async () => {
    await seedAttempts("signup:203.0.113.7", MAX_SIGNUPS_PER_CLIENT);
    const from = (ip: string, email: string) =>
      post("auth/register", { email, password: CREDENTIALS.password }, { "x-forwarded-for": ip });

    const refused = await from("203.0.113.7", "flood@krave.test");
    expect(refused.status).toBe(400);
    expect((await refused.json()).message).toMatch(/too many new accounts/i);
    expect(await count("users")).toBe(0);

    // Another address is unaffected.
    expect((await from("198.51.100.4", "neighbour@krave.test")).status).toBe(201);

    // A full quota from before the window neither blocks nor lingers.
    await seedAttempts("signup:192.0.2.9", MAX_SIGNUPS_PER_CLIENT, LOGIN_WINDOW_MINUTES + 1);
    expect((await from("192.0.2.9", "returning@krave.test")).status).toBe(201);
    const left = await one<{ n: number }>(
      "SELECT COUNT(*)::int AS n FROM login_attempts WHERE attempt_key = $1",
      ["signup:192.0.2.9"]
    );
    expect(left?.n).toBe(1);
  });

  it("caps guest orders per address without limiting signed-in customers there", async () => {
    await seedAttempts("guest-order:203.0.113.8", MAX_GUEST_ORDERS_PER_CLIENT);
    const ip = { "x-forwarded-for": "203.0.113.8" };

    const refused = await post("order/makeOrder", CHECKOUT, ip);
    expect(refused.status).toBe(400);
    expect((await refused.json()).message).toMatch(/too many guest orders/i);
    expect(await count("delivery_tickets")).toBe(0);

    const user = await registerUser(CREDENTIALS);
    const { token } = await createSession(user.id);
    const signedIn = await post("order/makeOrder", CHECKOUT, {
      ...ip,
      cookie: `${SESSION_COOKIE}=${token}`,
    });
    expect(signedIn.status).toBe(201);
    expect(await count("delivery_tickets")).toBe(1);
  });

  it("creates no reset token in production, where there is no way to deliver it", async () => {
    await registerUser(CREDENTIALS);
    vi.stubEnv("NODE_ENV", "production");
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await post("auth/forgot", { email: CREDENTIALS.email });

    expect(response.status).toBe(503);
    expect((await response.json()).message).toMatch(/not available/i);
    expect(await count("password_resets")).toBe(0);
    expect(logged).not.toHaveBeenCalled();
  });
});
