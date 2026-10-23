import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/webroutes/[...slug]/route";
import { createDemoOrder, DEMO_PAYMENT_METHODS } from "@/lib/checkout";
import { closePool, one } from "@/lib/server/pg";
import { createSession, registerUser, SESSION_COOKIE } from "@/lib/server/auth";
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
