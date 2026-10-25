import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasTestDatabase,
  resetTestDatabase,
  startTestDatabase,
  stopTestDatabase,
} from "./support/testDb";
import {
  createPasswordReset,
  MAX_CLIENT_LOGIN_ATTEMPTS,
  MAX_LOGIN_ATTEMPTS,
  registerUser,
  resetPassword,
  verifyCredentials,
} from "@/lib/server/auth";
import { newId } from "@/lib/ids";
import { createDemoOrder, DEMO_PAYMENT_METHODS } from "@/lib/checkout";
import { deleteOrder, listOrders, saveOrder } from "@/lib/server/accountStore";
import { grantOutletStaff } from "@/lib/server/staff";
import { getPool, one } from "@/lib/server/pg";
import {
  advanceDeliveryTicket,
  createDeliveryTicket,
  listDeliveryTickets,
} from "@/lib/server/kitchenStore";
import {
  addItemToSession,
  openShift,
  openTableSession,
  POS_TABLES,
} from "@/lib/pos/posEngine";
import { MENU, OUTLET } from "./support/posFixture";
import {
  CHECKOUT_INTENT_STORAGE_KEY,
  checkoutFingerprint,
  readCheckoutIntent,
  resolveCheckoutIntent,
  writeCheckoutIntent,
} from "@/lib/checkoutIntent";

const CREDENTIALS = { email: "chef@krave.test", password: "135790" };
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Demo orders and kitchen tickets run on the legacy fictional catalog, which the app no longer ships.
vi.mock("@/data/zomatoReconstructedData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/zomatoReconstructedData")>()),
  ...(await import("./support/legacyCatalog")).LEGACY_CATALOG,
}));

function memoryStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    data,
  };
}

describe("newId outside a secure context", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to getRandomValues when randomUUID is missing (plain-HTTP LAN terminal)", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    expect(typeof globalThis.crypto.randomUUID).toBe("undefined");

    const ids = Array.from({ length: 500 }, () => newId());
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses randomUUID when the context provides it", () => {
    expect(newId()).toMatch(UUID_V4);
  });

  it("lets the POS open a table and ring up an item without randomUUID", () => {
    const real = globalThis.crypto;
    vi.stubGlobal("crypto", { getRandomValues: real.getRandomValues.bind(real) });
    const session = openTableSession({
      ...OUTLET,
      tableId: POS_TABLES[0].tableId,
      guestCount: 2,
      serverName: "Asha",
    });
    const withLine = addItemToSession(session, MENU[0]);
    expect(withLine.lines).toHaveLength(1);
    expect(openShift({ ...OUTLET, openedBy: "Asha", openingCash: 500 }).shiftId).toMatch(/^SHIFT-/);
  });
});

describe("checkout intent keeps one idempotency key per order", () => {
  const request = {
    items: [{ itemId: "ctl_1", quantity: 2, optionIds: [], cookingInstruction: "" }],
    addressId: "addr_1",
    paymentMethod: "UPI",
    priceLock: "lock-a",
  };

  it("reuses the key when the same order is retried", () => {
    const first = resolveCheckoutIntent(checkoutFingerprint(request), null);
    const retry = resolveCheckoutIntent(checkoutFingerprint({ ...request }), first);
    expect(retry.key).toBe(first.key);
  });

  it("keeps the key when only the price lock was re-issued", () => {
    const first = resolveCheckoutIntent(checkoutFingerprint(request), null);
    const retry = resolveCheckoutIntent(checkoutFingerprint({ ...request, priceLock: "lock-b" }), first);
    expect(retry.key).toBe(first.key);
  });

  it("mints a new key once the order itself changes", () => {
    const first = resolveCheckoutIntent(checkoutFingerprint(request), null);
    const changedCart = {
      ...request,
      items: [{ ...request.items[0], quantity: 3 }],
    };
    expect(resolveCheckoutIntent(checkoutFingerprint(changedCart), first).key).not.toBe(first.key);
    expect(
      resolveCheckoutIntent(checkoutFingerprint({ ...request, addressId: "addr_2" }), first).key
    ).not.toBe(first.key);
  });

  it("survives a reload through tab storage and is cleared after success", () => {
    const storage = memoryStorage();
    const intent = resolveCheckoutIntent(checkoutFingerprint(request), null);
    writeCheckoutIntent(intent, storage);

    const afterReload = readCheckoutIntent(storage);
    expect(resolveCheckoutIntent(checkoutFingerprint(request), afterReload).key).toBe(intent.key);

    writeCheckoutIntent(null, storage);
    expect(readCheckoutIntent(storage)).toBeNull();
  });

  it("ignores corrupt stored data and never throws when storage is unavailable", () => {
    expect(readCheckoutIntent(memoryStorage({ [CHECKOUT_INTENT_STORAGE_KEY]: "{not json" }))).toBeNull();
    expect(readCheckoutIntent(memoryStorage({ [CHECKOUT_INTENT_STORAGE_KEY]: '{"key":""}' }))).toBeNull();

    const blocked = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(readCheckoutIntent(blocked)).toBeNull();
    expect(() => writeCheckoutIntent({ key: "k", fingerprint: "f" }, blocked)).not.toThrow();
    expect(() => writeCheckoutIntent(null, undefined)).not.toThrow();
  });
});

/** Waits until `count` connections are queued on a lock, so a test can fix the order of a race. */
async function lockWaiters(count: number) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const row = await one<{ n: number }>(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'"
    );
    if ((row?.n ?? 0) >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected ${count} lock waiter(s)`);
}

describe.skipIf(!hasTestDatabase)("auth under concurrency", () => {
  beforeAll(async () => {
    await startTestDatabase();
  });

  afterAll(async () => {
    await stopTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  it("caps a parallel burst of guesses at the per-account limit", async () => {
    await registerUser(CREDENTIALS);
    const burst = Array.from({ length: MAX_LOGIN_ATTEMPTS * 3 }, (_, i) =>
      verifyCredentials({ email: CREDENTIALS.email, password: `guess-number-${i}` }, `10.0.0.${i}`)
    );
    const outcomes = await Promise.allSettled(burst);
    const messages = outcomes.map((o) => (o.status === "rejected" ? String(o.reason?.message) : "ok"));

    // Every outcome is one of the two expected answers, so a stray error is reported by name
    // rather than surfacing only as a count that is one short.
    const unexpected = messages.filter((m) => !/incorrect|too many/i.test(m));
    expect(unexpected).toEqual([]);

    // Every guess that reached the password check counted against the limit before it ran.
    expect(messages.filter((m) => /incorrect/i.test(m))).toHaveLength(MAX_LOGIN_ATTEMPTS);
    expect(messages.filter((m) => /too many/i.test(m))).toHaveLength(MAX_LOGIN_ATTEMPTS * 2);
    await expect(verifyCredentials(CREDENTIALS, "10.9.9.9")).rejects.toThrow(/too many/i);
  });

  it("does not let a successful sign-in wipe the client's failure count", async () => {
    await registerUser(CREDENTIALS);
    const attacker = "198.51.100.23";
    for (let attempt = 0; attempt < MAX_CLIENT_LOGIN_ATTEMPTS - 1; attempt += 1) {
      await expect(
        verifyCredentials({ email: `victim-${attempt}@krave.test`, password: "spray-spray-spray" }, attacker)
      ).rejects.toThrow(/incorrect/i);
    }
    // The attacker signs in to an account they own from the same address...
    await expect(verifyCredentials(CREDENTIALS, attacker)).resolves.toBeTruthy();
    // ...and the spray is still counted: one more failure reaches the ceiling.
    await expect(
      verifyCredentials({ email: "victim-last@krave.test", password: "spray-spray-spray" }, attacker)
    ).rejects.toThrow(/incorrect/i);
    await expect(
      verifyCredentials({ email: "victim-after@krave.test", password: "spray-spray-spray" }, attacker)
    ).rejects.toThrow(/too many/i);
    // Reaching the client ceiling takes one real sign-in per attempt, each a few round trips.
  }, 180_000);

  it("lets only one of two concurrent resets use the same token", async () => {
    await registerUser(CREDENTIALS);
    const { token } = (await createPasswordReset({ email: CREDENTIALS.email }))!;

    const outcomes = await Promise.allSettled([
      resetPassword(token, "135796"),
      resetPassword(token, "246816"),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toHaveLength(1);

    const winner = outcomes[0].status === "fulfilled" ? "135796" : "246816";
    await expect(
      verifyCredentials({ email: CREDENTIALS.email, password: winner }, "10.1.1.1")
    ).resolves.toMatchObject({ email: CREDENTIALS.email });
  });

  it("rejects a reset whose token was superseded while its password was hashing", async () => {
    await registerUser(CREDENTIALS);
    const { token } = (await createPasswordReset({ email: CREDENTIALS.email }))!;

    // Left to timing, a cold connection decides which request reaches the row first. A held
    // row lock fixes the order: the newer request's DELETE queues first, the in-flight
    // reset passes its pre-check and hashes, then queues its claim behind the DELETE.
    const holder = await getPool().connect();
    let inFlight: ReturnType<typeof resetPassword> | undefined;
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM password_resets WHERE used_at IS NULL FOR UPDATE");

      const newer = createPasswordReset({ email: CREDENTIALS.email });
      await lockWaiters(1);
      // A valid PIN, so the request gets past validation and is caught by the token race.
      inFlight = resetPassword(token, "864201");
      // Keeps a rejection from going unhandled before it is awaited below.
      inFlight.catch(() => undefined);
      await lockWaiters(2);

      await holder.query("COMMIT");
      await newer;
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }

    await expect(inFlight).rejects.toThrow(/expired|already used/i);
    await expect(verifyCredentials(CREDENTIALS, "10.2.2.2")).resolves.toMatchObject({
      email: CREDENTIALS.email,
    });
  });

  it("leaves one working link when two reset requests for an account land together", async () => {
    await registerUser(CREDENTIALS);
    await createPasswordReset({ email: CREDENTIALS.email });

    // Both requests queue behind a held lock on the existing link, then run back to back.
    // Each one's cleanup must see the link the other just made, or both links stay live.
    const holder = await getPool().connect();
    const requests: Array<ReturnType<typeof createPasswordReset>> = [];
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT 1 FROM password_resets WHERE used_at IS NULL FOR UPDATE");
      requests.push(
        createPasswordReset({ email: CREDENTIALS.email }),
        createPasswordReset({ email: CREDENTIALS.email })
      );
      await lockWaiters(2);
      await holder.query("COMMIT");
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      holder.release();
    }
    const tokens = (await Promise.all(requests)).map((reset) => reset!.token);

    const used: string[] = [];
    for (const [i, token] of tokens.entries()) {
      try {
        // A valid PIN each time, so only the link itself can be refused.
        await resetPassword(token, `86420${i}`);
        used.push(token);
      } catch (error) {
        expect(String(error)).toMatch(/expired|already used/i);
      }
    }
    expect(used).toHaveLength(1);
  });
});

describe.skipIf(!hasTestDatabase)("cancelling an order reaches the kitchen", () => {
  const CHECKOUT = {
    items: [{ itemId: "ctl_820099425", quantity: 1, optionIds: ["opt_500g"] }],
    addressId: "addr_cp_514",
    paymentMethod: DEMO_PAYMENT_METHODS[0],
    couponCode: null,
    isGoldMember: false,
    riderTip: 0,
  };

  beforeAll(async () => {
    await startTestDatabase();
  });

  afterAll(async () => {
    await stopTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
  });

  async function placeOrder() {
    const user = await registerUser(CREDENTIALS);
    const order = createDemoOrder(CHECKOUT);
    await createDeliveryTicket(order);
    await saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });

    const operator = await registerUser({ ...CREDENTIALS, email: "counter@krave.test" });
    await grantOutletStaff(operator.id, operator.id, order.resId);
    return { user, order, counterId: operator.id };
  }

  it("takes a ticket nobody accepted off the counter, so it is not cooked", async () => {
    const { user, order, counterId } = await placeOrder();
    await deleteOrder(user.id, order.orderId);

    expect(await listOrders(user.id)).toHaveLength(0);
    expect(await listDeliveryTickets(order.resId)).toHaveLength(0);
    await expect(
      advanceDeliveryTicket(counterId, order.orderId, "ACCEPTED")
    ).rejects.toThrow(/not on this counter/i);
  });

  it("refuses once the kitchen has accepted the ticket and leaves both records intact", async () => {
    const { user, order, counterId } = await placeOrder();
    await advanceDeliveryTicket(counterId, order.orderId, "ACCEPTED");

    await expect(deleteOrder(user.id, order.orderId)).rejects.toThrow(
      /already reached the kitchen/i
    );
    expect(await listOrders(user.id)).toHaveLength(1);
    expect((await listDeliveryTickets(order.resId))[0]).toMatchObject({ status: "ACCEPTED" });
  });
});
