import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasTestDatabase,
  resetTestDatabase,
  startTestDatabase,
  stopTestDatabase,
} from "./support/testDb";
import { outletInput } from "./support/posFixture";
import { seedPosOutlet } from "./support/posRestaurant";
import { one, run } from "@/lib/server/pg";
import {
  createPasswordReset,
  createSession,
  destroySession,
  getUserForToken,
  MAX_CLIENT_LOGIN_ATTEMPTS,
  MAX_LOGIN_ATTEMPTS,
  registerUser,
  resetPassword,
  revokeAllSessions,
  setGoldMembership,
  verifyCredentials,
  type AccountUser,
} from "@/lib/server/auth";
import {
  addNotification,
  advanceOrderStage,
  clearNotifications,
  deleteOrder,
  findOrderByIdempotencyKey,
  hasVisited,
  listBookmarks,
  listNotifications,
  listOrders,
  listReservations,
  markNotificationsRead,
  saveOrder,
  saveReservation,
  setBookmarks,
  sweepScheduledOrders,
} from "@/lib/server/accountStore";
import {
  assertItemsAvailable,
  createDemoOrder,
  createValidatedReservation,
  DEMO_PAYMENT_METHODS,
  scheduledDueAt,
  validateCheckout,
  validateKitchenHandling,
} from "@/lib/checkout";
import {
  applyQuoteLock,
  issueQuoteLock,
  QUOTE_LOCK_MINUTES,
} from "@/lib/server/quoteLock";
import type { CartLineItem } from "@/types/krave";
import {
  advanceDeliveryTicket,
  createDeliveryTicket,
  listDeliveryTickets,
  prepTimeStats,
} from "@/lib/server/kitchenStore";
import { claimDineInBill, listDineInBills } from "@/lib/server/dineInStore";
import {
  AUTO_REFUND_RECENT_LIMIT,
  DISPUTE_WINDOW_HOURS,
  fileDispute,
  listDisputeQueue,
  listDisputes,
  resolveDispute,
} from "@/lib/server/disputeStore";
import { listAudit } from "@/lib/server/auditLog";
import { grantOutletStaff, isOutletStaff } from "@/lib/server/staff";
import {
  listUnavailableItems,
  pruneUnknownAvailability,
  setDishAvailability,
} from "@/lib/server/menuStore";
import {
  loadFloorTables,
  loadFloorVersion,
  loadPosState,
  syncPosState,
} from "@/lib/server/posStore";
import {
  addCustomItemToSession,
  addItemToSession,
  calculatePosBill,
  openShift,
  openTableSession,
  sendPendingToKitchen,
  settleSession,
  type PosMenuItem,
  type PosOutlet,
} from "@/lib/pos/posEngine";
import { RESTAURANTS_DATA } from "@/data/zomatoReconstructedData";

// Orders, bookmarks, availability and kitchen tickets are the legacy marketplace engines,
// which still run on the fictional catalog the app no longer ships.
vi.mock("@/data/zomatoReconstructedData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/zomatoReconstructedData")>()),
  ...(await import("./support/legacyCatalog")).LEGACY_CATALOG,
}));

const CREDENTIALS = { email: "Chef@Krave.test", password: "135790" };
const CHECKOUT = {
  items: [{ itemId: "ctl_820099425", quantity: 1, optionIds: ["opt_500g"] }],
  addressId: "addr_cp_514",
  paymentMethod: DEMO_PAYMENT_METHODS[0],
  couponCode: "KRAVE50",
  isGoldMember: true,
  riderTip: 20,
};

// Needs a real Postgres: the stores rely on advisory locks, FOR UPDATE and statement
// triggers, none of which SQLite has. Skipped when TEST_DATABASE_URL is unset.
describe.skipIf(!hasTestDatabase)("server", () => {

beforeAll(async () => {
  await startTestDatabase();
});

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(async () => {
  await resetTestDatabase();
});

describe("Accounts and durable orders", () => {
  it("registers a user, normalises the email and rejects weak or duplicate signups", async () => {
    const user = await registerUser(CREDENTIALS);
    expect(user.email).toBe("chef@krave.test");
    expect(user.displayName).toBe("chef");
    expect(user.isGoldMember).toBe(false);

    await expect(registerUser(CREDENTIALS)).rejects.toThrow();
    await expect(registerUser({ email: "nope", password: CREDENTIALS.password })).rejects.toThrow();
    await expect(registerUser({ email: "a@b.co", password: "short" })).rejects.toThrow();
  });

  it("never stores the password and only accepts the correct one", async () => {
    const user = await registerUser(CREDENTIALS);
    const row = (await one<Record<string, unknown>>("SELECT * FROM users WHERE id = $1", [
      user.id,
    ]))!;

    expect(String(row.password_hash)).not.toContain(CREDENTIALS.password);
    expect(String(row.password_salt).length).toBeGreaterThan(16);

    await expect(verifyCredentials(CREDENTIALS)).resolves.toMatchObject({ id: user.id });
    // Email casing is normalised, so the same mailbox signs in either way.
    await expect(
      verifyCredentials({ email: "chef@krave.test", password: CREDENTIALS.password })
    ).resolves.toMatchObject({ id: user.id });

    await expect(
      verifyCredentials({ email: CREDENTIALS.email, password: "wrong-password-here" })
    ).rejects.toThrow();
    await expect(
      verifyCredentials({ email: "ghost@krave.test", password: CREDENTIALS.password })
    ).rejects.toThrow();
  });

  it("stores session tokens hashed and stops honouring them once destroyed", async () => {
    const user = await registerUser(CREDENTIALS);
    const { token } = await createSession(user.id);

    const stored = (await one<Record<string, unknown>>("SELECT token_hash FROM sessions"))!;
    expect(String(stored.token_hash)).not.toBe(token);

    expect((await getUserForToken(token))?.id).toBe(user.id);
    expect(await getUserForToken("not-a-token")).toBeNull();
    expect(await getUserForToken(undefined)).toBeNull();

    await destroySession(token);
    expect(await getUserForToken(token)).toBeNull();
  });

  it("rejects an expired session", async () => {
    const user = await registerUser(CREDENTIALS);
    const { token } = await createSession(user.id);
    await run("UPDATE sessions SET expires_at = $1", ["2000-01-01T00:00:00.000Z"]);
    expect(await getUserForToken(token)).toBeNull();
  });

  it("rebuilds a stored order from the catalog rather than from stored totals", async () => {
    const user = await registerUser(CREDENTIALS);
    const order = createDemoOrder(CHECKOUT);
    await saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: "key-1" });

    // Tamper with the stored total the way a compromised row would.
    await run("UPDATE orders SET grand_total = 1 WHERE id = $1", [order.orderId]);

    const [restored] = await listOrders(user.id);
    expect(restored.orderId).toBe(order.orderId);
    expect(restored.quote.grandTotal).toBe(order.quote.grandTotal);
    expect(restored.quote.grandTotal).not.toBe(1);
    expect(restored.items[0].unitPrice).toBe(order.items[0].unitPrice);
  });

  it("replays the same idempotency key instead of writing a second order", async () => {
    const user = await registerUser(CREDENTIALS);
    const order = createDemoOrder(CHECKOUT);
    await saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: "key-1" });

    expect((await findOrderByIdempotencyKey(user.id, "key-1"))?.orderId).toBe(order.orderId);
    expect(await findOrderByIdempotencyKey(user.id, "key-2")).toBeNull();
    expect(await findOrderByIdempotencyKey(user.id, null)).toBeNull();

    // A reused key is reported, not thrown, so a racing retry can fall back to replaying.
    await expect(saveOrder(user.id, createDemoOrder(CHECKOUT), {
        addressId: CHECKOUT.addressId,
        idempotencyKey: "key-1",
      })).resolves.toBe(false);
    expect(await listOrders(user.id)).toHaveLength(1);
  });

  it("keeps one account's orders out of another's", async () => {
    const owner = await registerUser(CREDENTIALS);
    const other = await registerUser({ email: "other@krave.test", password: CREDENTIALS.password });
    const order = createDemoOrder(CHECKOUT);
    await saveOrder(owner.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });

    expect(await listOrders(other.id)).toHaveLength(0);
    await expect(deleteOrder(other.id, order.orderId)).rejects.toThrow();
    await expect(advanceOrderStage(other.id, order.orderId, "KITCHEN_PREPARING")).rejects.toThrow();
    expect(await listOrders(owner.id)).toHaveLength(1);
  });

  it("cancels only before the kitchen stage, the same rule the browser uses", async () => {
    const user = await registerUser(CREDENTIALS);
    const order = createDemoOrder(CHECKOUT);
    await saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });

    await advanceOrderStage(user.id, order.orderId, "KITCHEN_PREPARING");
    expect((await listOrders(user.id))[0].stage).toBe("KITCHEN_PREPARING");
    await expect(deleteOrder(user.id, order.orderId)).rejects.toThrow();

    // Stages only move forward, so stepping back cannot reopen cancellation.
    await advanceOrderStage(user.id, order.orderId, "ORDER_CONFIRMED");
    expect((await listOrders(user.id))[0].stage).toBe("KITCHEN_PREPARING");
    await expect(deleteOrder(user.id, order.orderId)).rejects.toThrow();

    const fresh = createDemoOrder(CHECKOUT);
    await saveOrder(user.id, fresh, { addressId: CHECKOUT.addressId, idempotencyKey: null });
    await deleteOrder(user.id, fresh.orderId);
    expect(await listOrders(user.id)).toHaveLength(1);
    // Lines are removed with the order rather than left behind.
    expect(
      await one("SELECT COUNT(*)::int AS n FROM order_lines WHERE order_id = $1", [fresh.orderId])
    ).toMatchObject({ n: 0 });
  });

  it("stores reservations and revalidates them against the catalog on read", async () => {
    const user = await registerUser(CREDENTIALS);
    const reservation = createValidatedReservation({
      resId: 19677790,
      date: "Today, Oct 22",
      timeSlot: "07:30 PM",
      guests: 2,
      guestName: "Rohit Mengji",
      guestPhone: "+91 98765 43210",
    });
    await saveReservation(user.id, reservation);

    const [restored] = await listReservations(user.id);
    expect(restored.bookingId).toBe(reservation.bookingId);
    expect(restored.guests).toBe(2);

    await run("UPDATE reservations SET time_slot = $1 WHERE id = $2", [
      "03:00 AM",
      reservation.bookingId,
    ]);
    expect(await listReservations(user.id)).toHaveLength(0);
  });

  it("keeps bookmarks to known restaurants and replaces the whole set", async () => {
    const user = await registerUser(CREDENTIALS);
    const known = RESTAURANTS_DATA[0].resId;

    expect(await setBookmarks(user.id, [known, known, 404404, "nope"])).toEqual([known]);
    expect(await listBookmarks(user.id)).toEqual([known]);
    expect(await setBookmarks(user.id, [])).toEqual([]);
    expect(await listBookmarks(user.id)).toEqual([]);
    await expect(setBookmarks(user.id, "all")).rejects.toThrow();
  });

  it("persists a membership change", async () => {
    const user = await registerUser(CREDENTIALS);
    await setGoldMembership(user.id, true);
    await expect(verifyCredentials(CREDENTIALS)).resolves.toMatchObject({ isGoldMember: true });
  });

  it("locks out a brute-force run and still lets the real password through beforehand", async () => {
    await registerUser(CREDENTIALS);
    const wrong = { email: CREDENTIALS.email, password: "wrong-password-xyz" };

    for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt += 1) {
      await expect(verifyCredentials(wrong, "1.2.3.4")).rejects.toThrow(/incorrect/i);
    }
    // Even the correct password is refused once the window is exhausted.
    await expect(verifyCredentials(CREDENTIALS, "1.2.3.4")).rejects.toThrow(/too many/i);
  });

  it("does not lock a bystander who shares the attacker's address", async () => {
    await registerUser(CREDENTIALS);
    await registerUser({ email: "bystander@krave.test", password: CREDENTIALS.password });

    // One account is hammered from a shared NAT address.
    for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt += 1) {
      await expect(
        verifyCredentials({ email: CREDENTIALS.email, password: "wrong-password-xyz" }, "203.0.113.7")
      ).rejects.toThrow(/incorrect/i);
    }
    await expect(verifyCredentials(CREDENTIALS, "203.0.113.7")).rejects.toThrow(/too many/i);

    // Everyone else behind that address must still be able to sign in.
    await expect(
      verifyCredentials({ email: "bystander@krave.test", password: CREDENTIALS.password }, "203.0.113.7")
    ).resolves.toMatchObject({ email: "bystander@krave.test" });
  });

  it("throttles by client address as well as by email", async () => {
    await registerUser(CREDENTIALS);

    // Credential stuffing: many different addresses tried from one source. Each email stays
    // well under its own limit, so only the client ceiling can stop this.
    for (let attempt = 0; attempt < MAX_CLIENT_LOGIN_ATTEMPTS; attempt += 1) {
      await expect(
        verifyCredentials({ email: `spray-${attempt}@krave.test`, password: "nope-nope-nope" }, "9.9.9.9")
      ).rejects.toThrow();
    }

    await expect(verifyCredentials(CREDENTIALS, "9.9.9.9")).rejects.toThrow(/too many/i);
    // The account itself is untouched, so it still signs in from anywhere else.
    await expect(verifyCredentials(CREDENTIALS, "5.5.5.5")).resolves.toMatchObject({
      email: "chef@krave.test",
    });
    // Reaching the client ceiling takes one real sign-in per attempt, each a few round trips.
  }, 180_000);

  it("clears the failure streak after a correct sign-in", async () => {
    await registerUser(CREDENTIALS);
    for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS - 1; attempt += 1) {
      await expect(
        verifyCredentials({ email: CREDENTIALS.email, password: "bad-password-1" }, "7.7.7.7")
      ).rejects.toThrow();
    }
    await expect(verifyCredentials(CREDENTIALS, "7.7.7.7")).resolves.toBeTruthy();

    for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS - 1; attempt += 1) {
      await expect(
        verifyCredentials({ email: CREDENTIALS.email, password: "bad-password-2" }, "7.7.7.7")
      ).rejects.toThrow(/incorrect/i);
    }
  });

  it("resets a password with a single-use token and signs every device out", async () => {
    const user = await registerUser(CREDENTIALS);
    const { token: sessionToken } = await createSession(user.id);
    expect((await getUserForToken(sessionToken))?.id).toBe(user.id);

    const reset = (await createPasswordReset({ email: CREDENTIALS.email }))!;
    expect(reset.token.length).toBeGreaterThan(20);
    // The raw token is never stored.
    const stored = (await one<Record<string, unknown>>(
      "SELECT token_hash FROM password_resets"
    ))!;
    expect(String(stored.token_hash)).not.toBe(reset.token);

    await resetPassword(reset.token, "135794");

    expect(await getUserForToken(sessionToken)).toBeNull();
    await expect(verifyCredentials(CREDENTIALS)).rejects.toThrow();
    await expect(
      verifyCredentials({ email: CREDENTIALS.email, password: "135794" })
    ).resolves.toMatchObject({ id: user.id });

    // Single use: a second try with a perfectly good PIN is still refused.
    await expect(resetPassword(reset.token, "135793")).rejects.toThrow(/expired|already used/i);
  });

  it("refuses an expired, unknown or weak reset", async () => {
    await registerUser(CREDENTIALS);
    const reset = (await createPasswordReset({ email: CREDENTIALS.email }))!;

    await expect(resetPassword(reset.token, "short")).rejects.toThrow();
    await expect(resetPassword("not-a-real-token-value", "135794")).rejects.toThrow();

    await run("UPDATE password_resets SET expires_at = $1", ["2000-01-01T00:00:00.000Z"]);
    await expect(resetPassword(reset.token, "135794")).rejects.toThrow(/expired/i);
  });

  it("does not reveal whether an email has an account", async () => {
    expect(await createPasswordReset({ email: "ghost@krave.test" })).toBeNull();
    expect(await createPasswordReset({ email: "not-an-email" })).toBeNull();
  });

  it("lets a locked-out user back in after completing a reset", async () => {
    await registerUser(CREDENTIALS);
    for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt += 1) {
      await expect(
        verifyCredentials({ email: CREDENTIALS.email, password: "bad-password-3" }, "4.4.4.4")
      ).rejects.toThrow();
    }
    await expect(verifyCredentials(CREDENTIALS, "4.4.4.4")).rejects.toThrow(/too many/i);

    const reset = (await createPasswordReset({ email: CREDENTIALS.email }))!;
    await resetPassword(reset.token, "135794", "4.4.4.4");

    // Both the account lockout and the requesting client's lockout are lifted.
    await expect(
      verifyCredentials({ email: CREDENTIALS.email, password: "135794" }, "4.4.4.4")
    ).resolves.toMatchObject({ email: "chef@krave.test" });
  });

  it("signs out every device at once", async () => {
    const user = await registerUser(CREDENTIALS);
    const first = await createSession(user.id);
    const second = await createSession(user.id);

    await revokeAllSessions(user.id);
    expect(await getUserForToken(first.token)).toBeNull();
    expect(await getUserForToken(second.token)).toBeNull();
  });
});

describe("Dine-in terminal sync", () => {
  // Each test runs as the owner of a real restaurant whose menu is in the database.
  let user: AccountUser;
  let outlet: PosOutlet;
  let MENU: PosMenuItem[];

  beforeEach(async () => {
    user = await registerUser(CREDENTIALS);
    outlet = await seedPosOutlet(user);
    MENU = outlet.menu;
  });

  function firedTable(tableId = "T1") {
    return sendPendingToKitchen(
      addItemToSession(
        openTableSession({
          ...outletInput(outlet),
          tableId,
          guestCount: 2,
          serverName: "Asha",
        }),
        MENU[0],
        2
      )
    ).session;
  }

  it("stores a terminal's tables, tickets and shift, then returns them intact", async () => {
    const shift = openShift({ ...outletInput(outlet), openedBy: "Meera", openingCash: 2000 });
    const session = firedTable();

    const result = await syncPosState(user.id, { sessions: [session], shift });
    expect(result.rejected).toEqual([]);
    expect(result.sessions).toHaveLength(1);
    expect(result.shift?.shiftId).toBe(shift.shiftId);

    const [stored] = result.sessions;
    expect(stored.sessionId).toBe(session.sessionId);
    expect(stored.tickets).toHaveLength(1);
    expect(stored.tickets[0].lines[0].quantity).toBe(2);
    expect(stored.lines[0].kotNumber).toBe(1);
    expect(calculatePosBill(stored).grandTotal).toBe(calculatePosBill(session).grandTotal);

    expect((await loadPosState(user.id)).sessions).toHaveLength(1);
  });

  it("reprices menu dishes from the restaurant's menu instead of trusting the terminal", async () => {
    const session = firedTable();
    // An offline terminal could send anything; the money must not come from it.
    const tampered = {
      ...session,
      lines: session.lines.map((line) => ({ ...line, unitPrice: 1 })),
    };

    const [stored] = (await syncPosState(user.id, { sessions: [tampered], shift: null })).sessions;
    expect(MENU[0]).toMatchObject({ name: "Mutton Biriyani (Half)", price: 120 });
    expect(stored.lines[0].unitPrice).toBe(120);
    expect(calculatePosBill(stored).grandTotal).toBe(calculatePosBill(session).grandTotal);
  });

  it("names the bill after the restaurant, not whatever the terminal sent", async () => {
    const renamed = { ...firedTable(), outletName: "Somebody Else's Cafe" };
    const shift = { ...openShift({ ...outletInput(outlet), openedBy: "Meera", openingCash: 500 }), outletName: "Elsewhere" };

    const result = await syncPosState(user.id, { sessions: [renamed], shift });
    expect(result.sessions[0].outletName).toBe("Jagadamba Maratha Khanawali");
    expect(result.shift?.outletName).toBe("Jagadamba Maratha Khanawali");
  });

  it("refuses tables and shifts for a restaurant this account does not run", async () => {
    const rival = await registerUser({ email: "rival@krave.test", password: CREDENTIALS.password });
    // The rival's terminal claims the owner's outlet; an unknown outlet id is no better.
    const intruding = firedTable();
    const unknown = { ...firedTable("T2"), outletId: outlet.outletId + 999 };
    const shift = openShift({ ...outletInput(outlet), openedBy: "Meera", openingCash: 500 });

    const result = await syncPosState(rival.id, { sessions: [intruding, unknown], shift });
    expect(result.sessions).toEqual([]);
    expect(result.shift).toBeNull();
    expect(result.rejected.map((entry) => entry.sessionId).sort()).toEqual(
      [intruding.sessionId, unknown.sessionId].sort()
    );
    expect(result.rejected[0].reason).toMatch(/cannot bill/i);
    expect(result.conflicts).toEqual([]);
  });

  it("keeps the price a dish was rung up at when the menu changes mid-meal", async () => {
    const first = await syncPosState(user.id, { sessions: [firedTable()], shift: null });
    const [stored] = first.sessions;
    const [itemId] = MENU[0].itemId.split("~");
    await run("UPDATE menu_items SET price_paise = 15000 WHERE id = $1", [itemId]);

    // Another plate of the same dish after the change is charged the new price.
    const more = sendPendingToKitchen(addItemToSession(stored, MENU[0], 1)).session;
    const [after] = (await syncPosState(user.id, { sessions: [more], shift: null })).sessions;
    expect(after.lines.map((line) => line.unitPrice)).toEqual([120, 150]);
  });

  it("still settles a dish taken off the menu after it was ordered, but not one deleted", async () => {
    const session = firedTable();
    const [itemId] = MENU[0].itemId.split("~");
    await run("UPDATE menu_items SET available = 0, published = 0 WHERE id = $1", [itemId]);

    const settled = await syncPosState(user.id, {
      sessions: [settleSession(session, "CASH", 100000)],
      shift: null,
    });
    expect(settled.rejected).toEqual([]);
    expect(settled.sessions[0].lines[0].unitPrice).toBe(120);

    const chickenId = MENU[2].itemId.split("~")[0];
    const orphan = firedTable("T2");
    const withChicken = addItemToSession(orphan, MENU[2], 1);
    await run("DELETE FROM menu_items WHERE id = $1", [chickenId]);
    const result = await syncPosState(user.id, { sessions: [withChicken], shift: null });
    expect(result.rejected).toEqual([
      { sessionId: orphan.sessionId, reason: `"${MENU[2].name}" is no longer on the menu.` },
    ]);
  });

  it("keeps an operator's off-menu price but refuses an impossible one", async () => {
    const custom = sendPendingToKitchen(
      addCustomItemToSession(
        openTableSession({
          ...outletInput(outlet),
          tableId: "T2",
          guestCount: 2,
          serverName: "Asha",
        }),
        { name: "Chef Special Soda", price: 180, dietary: "veg", quantity: 1 }
      )
    ).session;

    const [stored] = (await syncPosState(user.id, { sessions: [custom], shift: null })).sessions;
    expect(stored.lines[0].unitPrice).toBe(180);

    const absurd = {
      ...custom,
      lines: custom.lines.map((line) => ({ ...line, unitPrice: 99999999 })),
    };
    const result = await syncPosState(user.id, { sessions: [absurd], shift: null });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].sessionId).toBe(custom.sessionId);
    // An unusable price is permanent, not something reloading would fix.
    expect(result.conflicts).toEqual([]);
  });

  it("reports the settled total it computed rather than one the terminal supplied", async () => {
    const settled = settleSession(firedTable(), "CASH", 100000);
    const expected = calculatePosBill(settled).grandTotal;

    const result = await syncPosState(user.id, { sessions: [settled], shift: null });
    expect(result.settledTotal).toBe(expected);
    expect(result.sessions[0].payment?.method).toBe("CASH");
  });

  it("keeps one account's floor out of another's", async () => {
    const other = await registerUser({ email: "other@krave.test", password: CREDENTIALS.password });
    await syncPosState(user.id, { sessions: [firedTable()], shift: null });

    expect((await loadPosState(other.id)).sessions).toHaveLength(0);
    expect((await loadPosState(user.id)).sessions).toHaveLength(1);
  });

  it("shows an open table to every waiter who can bill the outlet", async () => {
    const waiter = await registerUser({ email: "waiter@krave.test", password: CREDENTIALS.password });
    const restaurant = await one<{ id: string }>(
      "SELECT id FROM managed_restaurants WHERE pos_outlet_id = $1",
      [outlet.outletId]
    );
    await run(
      `INSERT INTO restaurant_memberships (restaurant_id, user_id, role, granted_at, granted_by)
       VALUES ($1, $2, 'staff', $3, $4)`,
      [restaurant?.id, waiter.id, new Date().toISOString(), user.id]
    );

    const opened = await syncPosState(user.id, { sessions: [firedTable()], shift: null });
    expect((await loadPosState(waiter.id)).sessions.map((session) => session.sessionId)).toEqual([
      opened.sessions[0].sessionId,
    ]);

    const [openedTable] = opened.sessions;
    const added = sendPendingToKitchen(addItemToSession(openedTable, MENU[0], 1)).session;
    const afterWaiter = await syncPosState(waiter.id, { sessions: [added], shift: null });
    expect(afterWaiter.rejected).toEqual([]);
    expect(afterWaiter.conflicts).toEqual([]);
    const shared = (await loadPosState(user.id)).sessions.find(
      (session) => session.sessionId === openedTable.sessionId
    );
    expect(shared?.lines.map((line) => line.quantity)).toEqual([2, 1]);
  });

  it("replaces the stored floor on each sync instead of duplicating it", async () => {
    const session = firedTable();

    await syncPosState(user.id, { sessions: [session], shift: null });
    const second = await syncPosState(user.id, { sessions: [session], shift: null });

    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0].lines).toHaveLength(1);
    expect(second.sessions[0].tickets).toHaveLength(1);
  });

  it("drops a malformed table rather than failing the whole sync", async () => {
    const good = firedTable();
    const result = await syncPosState(user.id, {
      sessions: [good, { sessionId: "not-a-session" }, null],
      shift: null,
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe(good.sessionId);
  });

  it("rejects a second terminal's stale write instead of overwriting the first", async () => {
    const session = firedTable();

    // Terminal A syncs and learns the new revision.
    const first = await syncPosState(user.id, { sessions: [session], shift: null });
    const revisionA = first.sessions[0].revision;
    expect(revisionA).toBe(1);

    // Terminal A adds a dish and syncs again, which moves the revision on.
    const advanced = addItemToSession({ ...session, revision: revisionA }, MENU[1], 1);
    const second = await syncPosState(user.id, { sessions: [advanced], shift: null });
    expect(second.conflicts).toEqual([]);
    expect(second.sessions[0].revision).toBe(2);

    // Terminal B still believes it is on the old revision; its write must be refused.
    const stale = addItemToSession({ ...session, revision: revisionA }, MENU[2], 5);
    const third = await syncPosState(user.id, { sessions: [stale], shift: null });
    expect(third.conflicts).toHaveLength(1);
    expect(third.conflicts[0].reason).toMatch(/another terminal/i);
    // A stale edit is recoverable by reloading, so it is not a hard rejection.
    expect(third.rejected).toEqual([]);

    // The first terminal's work is untouched.
    expect(third.sessions[0].revision).toBe(2);
    expect(third.sessions[0].lines).toHaveLength(2);
    expect(third.sessions[0].lines.some((line) => line.quantity === 5)).toBe(false);
  });

  it("answers a sync with only the tables it sent, not the whole floor and its bills", async () => {
    await syncPosState(user.id, {
      sessions: [settleSession(firedTable("T1"), "CASH", 100000), firedTable("T2")],
      shift: null,
    });

    const third = firedTable("T3");
    const result = await syncPosState(user.id, { sessions: [third], shift: null });
    expect(result.sessions.map((session) => session.tableId)).toEqual(["T3"]);
    // The paid T1 is neither sent back nor recorded again.
    expect(result.claimCodes).toEqual({});
    expect(result.billNumbers).toEqual({});
  });

  it("polls a shared floor as one small version until something changes", async () => {
    const waiter = await registerUser({ email: "waiter@krave.test", password: CREDENTIALS.password });
    const restaurant = await one<{ id: string }>(
      "SELECT id FROM managed_restaurants WHERE pos_outlet_id = $1",
      [outlet.outletId]
    );
    await run(
      `INSERT INTO restaurant_memberships (restaurant_id, user_id, role, granted_at, granted_by)
       VALUES ($1, $2, 'staff', $3, $4)`,
      [restaurant?.id, waiter.id, new Date().toISOString(), user.id]
    );

    const empty = await loadFloorVersion(waiter, null);
    expect(empty.heads).toEqual([]);
    expect(await loadFloorVersion(waiter, empty.version)).toEqual({ version: empty.version });

    // The owner opens a table: the waiter's next poll sees the version move, with its revision.
    const [opened] = (await syncPosState(user.id, { sessions: [firedTable()], shift: null })).sessions;
    const moved = await loadFloorVersion(waiter, empty.version);
    expect(moved.version).not.toBe(empty.version);
    expect(moved.heads).toEqual([[opened.sessionId, 1]]);
    expect(await loadFloorVersion(waiter, moved.version)).toEqual({ version: moved.version });

    // The waiter fetches just that table, adds to it, and the owner's floor moves again.
    const [shared] = (await loadFloorTables(waiter, [opened.sessionId])).sessions;
    expect(shared.lines.map((line) => line.quantity)).toEqual([2]);
    const added = sendPendingToKitchen(addItemToSession(shared, MENU[0], 1)).session;
    expect((await syncPosState(waiter.id, { sessions: [added], shift: null })).conflicts).toEqual([]);
    const afterAdd = await loadFloorVersion(user, moved.version);
    expect(afterAdd.heads).toEqual([[opened.sessionId, 2]]);

    // Paying the bill closes it on every terminal: it leaves the open floor.
    const [latest] = (await loadFloorTables(user, [opened.sessionId])).sessions;
    await syncPosState(user.id, { sessions: [settleSession(latest, "UPI", 0)], shift: null });
    const paid = await loadFloorVersion(waiter, afterAdd.version);
    expect(paid.heads).toEqual([]);
    const [closed] = (await loadFloorTables(waiter, [opened.sessionId])).sessions;
    expect(closed.status).toBe("SETTLED");
  });

  it("never shows another restaurant's tables, even when asked for them by id", async () => {
    const [opened] = (await syncPosState(user.id, { sessions: [firedTable()], shift: null })).sessions;
    const stranger = await registerUser({ email: "stranger@krave.test", password: CREDENTIALS.password });

    const floor = await loadFloorVersion(stranger, null);
    expect(floor.heads).toEqual([]);
    expect((await loadFloorTables(stranger, [opened.sessionId])).sessions).toEqual([]);
  });

  it("lets only one of two phones that save the same table at the same moment through", async () => {
    const waiter = await registerUser({ email: "waiter@krave.test", password: CREDENTIALS.password });
    const restaurant = await one<{ id: string }>(
      "SELECT id FROM managed_restaurants WHERE pos_outlet_id = $1",
      [outlet.outletId]
    );
    await run(
      `INSERT INTO restaurant_memberships (restaurant_id, user_id, role, granted_at, granted_by)
       VALUES ($1, $2, 'staff', $3, $4)`,
      [restaurant?.id, waiter.id, new Date().toISOString(), user.id]
    );
    const [opened] = (await syncPosState(user.id, { sessions: [firedTable()], shift: null })).sessions;

    // Open every pooled connection first, or one save waits on a new connection and they never overlap.
    await Promise.all(Array.from({ length: 4 }, () => one("SELECT pg_sleep(0.2)")));
    const [mine, theirs] = await Promise.all([
      syncPosState(user.id, { sessions: [addItemToSession(opened, MENU[1], 1)], shift: null }),
      syncPosState(waiter.id, { sessions: [addItemToSession(opened, MENU[2], 1)], shift: null }),
    ]);

    expect([mine.conflicts.length, theirs.conflicts.length].sort()).toEqual([0, 1]);
    const [stored] = (await loadFloorTables(user, [opened.sessionId])).sessions;
    expect(stored.revision).toBe(opened.revision + 1);
    expect(stored.lines).toHaveLength(2);
  });

  it("takes a phone's retry after its answer was lost, but not another phone's stale copy", async () => {
    const phone = "phone-a-0123456789";
    const [opened] = (
      await syncPosState(user.id, { sessions: [firedTable()], shift: null, device: phone })
    ).sessions;
    // The phone's next save reaches the server, but its answer never comes back.
    const lost = addItemToSession(opened, MENU[1], 1);
    await syncPosState(user.id, { sessions: [lost], shift: null, device: phone });

    // So it retries from the revision it still knows, with one more tap on top.
    const retry = addItemToSession(lost, MENU[2], 1);
    const retried = await syncPosState(user.id, { sessions: [retry], shift: null, device: phone });
    expect(retried.conflicts).toEqual([]);
    expect(retried.sessions[0].lines).toHaveLength(3);

    // Another phone, or a save that names no phone, still has to be on the latest revision.
    for (const device of ["phone-b-0123456789", undefined]) {
      const stale = addItemToSession(opened, MENU[3], 1);
      const refused = await syncPosState(user.id, { sessions: [stale], shift: null, device });
      expect(refused.conflicts).toHaveLength(1);
    }
    const [stored] = (await loadFloorTables(user, [opened.sessionId])).sessions;
    expect(stored.lines).toHaveLength(3);
  });
});

describe("Outlet-wide availability", () => {
  const DISH_ID = "ctl_820099425";
  const DISH_OUTLET = 19677790;

  /** Registers an account and makes it staff at the outlet that owns DISH_ID. */
  async function operator(email = CREDENTIALS.email) {
    const user = await registerUser({ ...CREDENTIALS, email });
    await grantOutletStaff(user.id, user.id, DISH_OUTLET);
    return user;
  }

  it("refuses a signed-in customer who is not staff at that outlet", async () => {
    const customer = await registerUser(CREDENTIALS);
    await expect(setDishAvailability(customer.id, { itemId: DISH_ID, unavailable: true })).rejects.toThrow(/do not have access/i);
    expect(await listUnavailableItems()).toEqual([]);

    // Staff at a different outlet is still not staff here.
    await grantOutletStaff(customer.id, customer.id, 18238278);
    expect(await isOutletStaff(customer.id, DISH_OUTLET)).toBe(false);
    await expect(setDishAvailability(customer.id, { itemId: DISH_ID, unavailable: true })).rejects.toThrow(/do not have access/i);
  });

  it("takes a dish off for the whole outlet, not just the marking device", async () => {
    const staff = await operator();
    expect(await listUnavailableItems()).toEqual([]);

    const marked = await setDishAvailability(staff.id, { itemId: DISH_ID, unavailable: true });
    expect(marked.unavailableItemIds).toContain(DISH_ID);

    // A second operator, and any anonymous reader, sees the same list.
    const other = await operator("second@krave.test");
    expect(await listUnavailableItems()).toContain(DISH_ID);

    await setDishAvailability(other.id, { itemId: DISH_ID, unavailable: false });
    expect(await listUnavailableItems()).toEqual([]);
  });

  it("derives the outlet from the catalog rather than the caller", async () => {
    const staff = await operator();
    await setDishAvailability(staff.id, { itemId: DISH_ID, unavailable: true });

    const owningOutlet = RESTAURANTS_DATA.find((restaurant) =>
      restaurant.menus.some((menu) =>
        menu.categories.some((category) => category.items.some((item) => item.id === DISH_ID))
      )
    )!;
    expect(await listUnavailableItems(owningOutlet.resId)).toEqual([DISH_ID]);

    const otherOutlet = RESTAURANTS_DATA.find(
      (restaurant) => restaurant.resId !== owningOutlet.resId
    )!;
    expect(await listUnavailableItems(otherOutlet.resId)).toEqual([]);
  });

  it("refuses an unknown dish or a missing flag", async () => {
    const staff = await operator();
    await expect(setDishAvailability(staff.id, { itemId: "ghost", unavailable: true })).rejects.toThrow();
    await expect(setDishAvailability(staff.id, { itemId: DISH_ID })).rejects.toThrow();
    await expect(setDishAvailability(staff.id, { itemId: DISH_ID, unavailable: "yes" })).rejects.toThrow();
  });

  it("blocks checkout for a dish that is off, without breaking order replay", async () => {
    const user = await operator();
    const validated = createDemoOrder(CHECKOUT);

    // Nothing is off yet, so the cart passes.
    expect(() => assertItemsAvailable(validated.items, [])).not.toThrow();

    await setDishAvailability(user.id, { itemId: DISH_ID, unavailable: true });
    const nowUnavailable = await listUnavailableItems();
    expect(() => assertItemsAvailable(validated.items, nowUnavailable)).toThrow(
      /sold out/i
    );

    // An order placed before it sold out must still read back from history.
    await saveOrder(user.id, validated, { addressId: CHECKOUT.addressId, idempotencyKey: null });
    expect(await listOrders(user.id)).toHaveLength(1);
  });

  it("drops a stale mark for a dish the catalog no longer has", async () => {
    const staff = await operator();
    await setDishAvailability(staff.id, { itemId: DISH_ID, unavailable: true });
    await run("INSERT INTO dish_availability VALUES ($1, $2, $3, $4)", [
      1,
      "ctl_removed_dish",
      new Date().toISOString(),
      staff.id,
    ]);

    expect(await pruneUnknownAvailability()).toBe(1);
    expect(await listUnavailableItems()).toEqual([DISH_ID]);
  });
});

describe("Kitchen tickets and prep time", () => {
  /** A counter operator for the outlet these orders belong to. */
  let counterId: string;

  beforeEach(async () => {
    const operator = await registerUser({ ...CREDENTIALS, email: "counter@krave.test" });
    counterId = operator.id;
    await grantOutletStaff(operator.id, operator.id, createDemoOrder(CHECKOUT).resId);
  });

  function placeOrder(handling?: unknown) {
    return createDemoOrder(handling === undefined ? CHECKOUT : { ...CHECKOUT, handling });
  }

  it("validates handling and refuses an allergy with no stated trigger", () => {
    expect(validateKitchenHandling(undefined)).toEqual({ flags: [], allergyNote: "" });
    expect(validateKitchenHandling({ flags: ["NO_CUTLERY"] })).toEqual({
      flags: ["NO_CUTLERY"],
      allergyNote: "",
    });

    expect(() => validateKitchenHandling({ flags: ["ALLERGY"] })).toThrow(/what the allergy is/i);
    expect(() =>
      validateKitchenHandling({ flags: ["ALLERGY"], allergyNote: "no" })
    ).toThrow();
    expect(() => validateKitchenHandling({ flags: ["TELEPORT_IT"] })).toThrow(/recognises/i);

    // The note is dropped when the flag is not set, so it cannot linger misleadingly.
    expect(
      validateKitchenHandling({ flags: ["JAIN"], allergyNote: "peanuts" }).allergyNote
    ).toBe("");
  });

  it("puts a placed order on the outlet's counter without any customer identity", async () => {
    const order = placeOrder({ flags: ["ALLERGY"], allergyNote: "severe peanut allergy" });
    await createDeliveryTicket(order);

    const [ticket] = await listDeliveryTickets(order.resId);
    expect(ticket.orderId).toBe(order.orderId);
    expect(ticket.status).toBe("NEW");
    expect(ticket.critical).toBe(true);
    expect(ticket.allergyNote).toBe("severe peanut allergy");
    expect(ticket.lines[0].quantity).toBe(1);

    // A counter screen has no use for these, so they must not be on the ticket at all.
    const serialized = JSON.stringify(ticket);
    expect(serialized).not.toContain(order.customerAddress.displayTitle);
    expect(serialized).not.toContain(order.customerAddress.pincode);

    // Another outlet's counter must not see it.
    expect(await listDeliveryTickets(18238278)).toHaveLength(0);
  });

  it("is idempotent, so a retried order never double-prints", async () => {
    const order = placeOrder();
    await createDeliveryTicket(order);
    await createDeliveryTicket(order);
    expect(await listDeliveryTickets(order.resId)).toHaveLength(1);
  });

  it("carries each dish's allergen declaration, keeping silence distinguishable", async () => {
    const order = placeOrder({ flags: ["ALLERGY"], allergyNote: "severe peanut allergy" });
    await createDeliveryTicket(order);

    const [ticket] = await listDeliveryTickets(order.resId);
    const declared = order.items[0].item.allergens ?? null;

    // null must survive the round trip: an undeclared dish must not arrive as "none".
    expect(ticket.lines[0].allergens).toEqual(declared);
    if (declared === null) {
      expect(ticket.lines[0].allergens).not.toEqual([]);
    }
  });

  it("marks only genuinely critical handling as critical", async () => {
    const relaxed = placeOrder({ flags: ["NO_CUTLERY", "LESS_SPICY"] });
    await createDeliveryTicket(relaxed);
    expect((await listDeliveryTickets(relaxed.resId))[0].critical).toBe(false);
  });

  it("moves a ticket forward one step at a time and never backwards", async () => {
    const order = placeOrder();
    await createDeliveryTicket(order);

    await expect(advanceDeliveryTicket(counterId, order.orderId, "READY")).rejects.toThrow(/one step/i);
    await expect(advanceDeliveryTicket(counterId, "KRV-unknown", "ACCEPTED")).rejects.toThrow(/not on this counter/i);
    await expect(advanceDeliveryTicket(counterId, order.orderId, "COOKED")).rejects.toThrow();

    const accepted = await advanceDeliveryTicket(counterId, order.orderId, "ACCEPTED");
    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.acceptedAt).not.toBeNull();

    const ready = await advanceDeliveryTicket(counterId, order.orderId, "READY");
    expect(ready.status).toBe("READY");
    expect(ready.prepMinutes).not.toBeNull();

    // Already finished; it cannot be reopened or re-advanced.
    await expect(advanceDeliveryTicket(counterId, order.orderId, "READY")).rejects.toThrow();
    await expect(advanceDeliveryTicket(counterId, order.orderId, "ACCEPTED")).rejects.toThrow();
  });

  it("reports prep time only once there are enough samples to mean anything", async () => {
    const outletId = RESTAURANTS_DATA[0].resId;
    expect(await prepTimeStats(outletId)).toEqual({
      sampleSize: 0,
      medianMinutes: null,
      p90Minutes: null,
    });

    // Three finished tickets is not a distribution.
    for (let i = 0; i < 3; i += 1) {
      const order = { ...placeOrder(), orderId: `KRV-sample-${i}` };
      await createDeliveryTicket(order);
      await advanceDeliveryTicket(counterId, order.orderId, "ACCEPTED");
      await advanceDeliveryTicket(counterId, order.orderId, "READY");
    }
    expect((await prepTimeStats(outletId)).medianMinutes).toBeNull();
    expect((await prepTimeStats(outletId)).sampleSize).toBe(3);

    // With a real sample it reports a measured spread, not one padded figure.
    for (let i = 3; i < 9; i += 1) {
      const order = { ...placeOrder(), orderId: `KRV-sample-${i}` };
      await createDeliveryTicket(order);
      await advanceDeliveryTicket(counterId, order.orderId, "ACCEPTED");
      await advanceDeliveryTicket(counterId, order.orderId, "READY");
      await run("UPDATE delivery_tickets SET ready_at = $1 WHERE order_id = $2", [
        new Date(Date.parse(order.placedAt) + i * 60_000).toISOString(),
        order.orderId,
      ]);
      await run("UPDATE delivery_tickets SET accepted_at = $1 WHERE order_id = $2", [
        order.placedAt,
        order.orderId,
      ]);
    }

    const stats = await prepTimeStats(outletId);
    expect(stats.sampleSize).toBe(9);
    expect(stats.medianMinutes).not.toBeNull();
    expect(stats.p90Minutes).toBeGreaterThanOrEqual(stats.medianMinutes!);
  });
});

describe("Refund disputes", () => {
  // The standard fixture order is dear enough to exceed the automatic ceiling on its
  // own, which is correct but makes a poor fixture for the auto-refund path.
  const CHEAP_CHECKOUT: typeof CHECKOUT = {
    ...CHECKOUT,
    items: [{ itemId: "ctl_raj_kachori", quantity: 1, optionIds: [] }],
    couponCode: "",
    riderTip: 0,
  };

  async function delivered(
    checkout: typeof CHECKOUT = CHEAP_CHECKOUT,
    email = CREDENTIALS.email
  ) {
    const user = await registerUser({ ...CREDENTIALS, email });
    const order = createDemoOrder(checkout);
    await saveOrder(user.id, order, { addressId: checkout.addressId, idempotencyKey: null });
    await advanceOrderStage(user.id, order.orderId, "ARRIVED");
    return { user, order };
  }

  const line = (order: ReturnType<typeof createDemoOrder>, quantity = 1) => [
    { itemId: order.items[0].item.id, quantity },
  ];

  it("refunds what was paid, not the menu price", async () => {
    const { user, order } = await delivered(CHECKOUT);
    const dispute = await fileDispute(user.id, {
      orderId: order.orderId,
      reason: "MISSING_ITEM",
      lines: line(order),
    });

    // This order is above the automatic ceiling, so it is reviewed rather than paid out.
    expect(dispute.status).toBe("UNDER_REVIEW");

    const cheap = await delivered(CHEAP_CHECKOUT, "cheap@krave.test");
    const paid = await fileDispute(cheap.user.id, {
      orderId: cheap.order.orderId,
      reason: "MISSING_ITEM",
      lines: line(cheap.order),
    });
    expect(paid.status).toBe("AUTO_REFUNDED");

    // The order carried GST and packaging, so the refund is its share of what was paid.
    const { grandTotal, riderTip, deliveryFee, platformFee } = cheap.order.quote;
    expect(paid.refundAmount).toBeLessThanOrEqual(
      grandTotal - riderTip - deliveryFee - platformFee
    );
    expect(paid.refundAmount).toBeGreaterThan(0);
  });

  it("sends a large claim to review instead of paying it out", async () => {
    const { user, order } = await delivered(CHECKOUT);
    const dispute = await fileDispute(user.id, {
      orderId: order.orderId,
      reason: "MISSING_ITEM",
      lines: line(order),
    });

    expect(dispute.status).toBe("UNDER_REVIEW");
    expect(dispute.refundAmount).toBe(0);
    expect(dispute.explanation).toMatch(/automatic limit/i);
  });

  it("refuses a second claim on the same order", async () => {
    const { user, order } = await delivered();
    await fileDispute(user.id, { orderId: order.orderId, reason: "MISSING_ITEM", lines: line(order) });
    await expect(fileDispute(user.id, { orderId: order.orderId, reason: "MISSING_ITEM", lines: line(order) })).rejects.toThrow(/already raised/i);
    expect(await listDisputes(user.id)).toHaveLength(1);
  });

  it("refuses claims for items or quantities that were never ordered", async () => {
    const { user, order } = await delivered();

    await expect(fileDispute(user.id, {
        orderId: order.orderId,
        reason: "MISSING_ITEM",
        lines: [{ itemId: "ctl_820099426", quantity: 1 }],
      })).rejects.toThrow(/not on this order/i);

    await expect(fileDispute(user.id, {
        orderId: order.orderId,
        reason: "MISSING_ITEM",
        lines: line(order, order.items[0].quantity + 1),
      })).rejects.toThrow(/more of an item than you ordered/i);
  });

  it("refuses another account's order and an undelivered one", async () => {
    const { order } = await delivered();
    const stranger = await registerUser({ ...CREDENTIALS, email: "stranger@krave.test" });
    await expect(fileDispute(stranger.id, {
        orderId: order.orderId,
        reason: "MISSING_ITEM",
        lines: line(order),
      })).rejects.toThrow(/not in your history/i);

    const user = await registerUser({ ...CREDENTIALS, email: "pending@krave.test" });
    const pending = createDemoOrder(CHEAP_CHECKOUT);
    await saveOrder(user.id, pending, { addressId: CHEAP_CHECKOUT.addressId, idempotencyKey: null });
    await expect(fileDispute(user.id, {
        orderId: pending.orderId,
        reason: "MISSING_ITEM",
        lines: line(pending),
      })).rejects.toThrow(/been delivered/i);
  });

  it("closes the window after the stated deadline", async () => {
    const { user, order } = await delivered();
    const tooLate = new Date(
      Date.parse(order.placedAt) + (DISPUTE_WINDOW_HOURS + 1) * 3_600_000
    );
    await expect(fileDispute(
        user.id,
        { orderId: order.orderId, reason: "MISSING_ITEM", lines: line(order) },
        tooLate
      )).rejects.toThrow(/Claims close/i);
  });

  it("stops refunding automatically once an account keeps claiming", async () => {
    const user = await registerUser(CREDENTIALS);

    const statuses: string[] = [];
    for (let attempt = 0; attempt < AUTO_REFUND_RECENT_LIMIT + 1; attempt += 1) {
      const order = createDemoOrder(CHEAP_CHECKOUT);
      await saveOrder(user.id, order, { addressId: CHEAP_CHECKOUT.addressId, idempotencyKey: null });
      await advanceOrderStage(user.id, order.orderId, "ARRIVED");
      statuses.push(
        (await fileDispute(user.id, {
          orderId: order.orderId,
          reason: "MISSING_ITEM",
          lines: line(order),
        })).status
      );
    }

    expect(statuses.slice(0, AUTO_REFUND_RECENT_LIMIT)).toEqual(
      Array(AUTO_REFUND_RECENT_LIMIT).fill("AUTO_REFUNDED")
    );
    expect(statuses.at(-1)).toBe("UNDER_REVIEW");
  });

  it("sends quality reports to a person, with a stated deadline", async () => {
    const { user, order } = await delivered();
    const dispute = await fileDispute(user.id, {
      orderId: order.orderId,
      reason: "QUALITY",
      lines: line(order),
    });

    expect(dispute.status).toBe("UNDER_REVIEW");
    expect(dispute.refundAmount).toBe(0);
    expect(dispute.reviewDueAt).not.toBeNull();
  });
});

describe("Settling a reviewed claim", () => {
  async function queued() {
    const claimant = await registerUser(CREDENTIALS);
    const reviewer = await registerUser({ ...CREDENTIALS, email: "ops@krave.test" });
    const order = createDemoOrder(CHECKOUT);
    await grantOutletStaff(reviewer.id, reviewer.id, order.resId);
    await saveOrder(claimant.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });
    await advanceOrderStage(claimant.id, order.orderId, "ARRIVED");

    // The standard order is above the ceiling, so it lands in the queue.
    const dispute = await fileDispute(claimant.id, {
      orderId: order.orderId,
      reason: "MISSING_ITEM",
      lines: [{ itemId: order.items[0].item.id, quantity: 1 }],
    });
    expect(dispute.status).toBe("UNDER_REVIEW");
    return { claimant, reviewer, dispute };
  }

  it("pays the amount assessed when the claim was filed", async () => {
    const { reviewer, dispute } = await queued();
    expect(dispute.refundAmount).toBe(0);
    expect(dispute.assessedAmount).toBeGreaterThan(0);

    const settled = await resolveDispute(reviewer.id, { disputeId: dispute.id, approve: true });
    expect(settled.status).toBe("REFUNDED");
    expect(settled.refundAmount).toBe(dispute.assessedAmount);
    expect(settled.resolvedAt).not.toBeNull();
  });

  it("refuses a signed-in customer who is not staff anywhere", async () => {
    const { dispute } = await queued();
    const bystander = await registerUser({ ...CREDENTIALS, email: "nosy@krave.test" });

    await expect(resolveDispute(bystander.id, { disputeId: dispute.id, approve: true })).rejects.toThrow(/do not have access/i);

    // Nor can they even read the queue of other people's claims.
    await expect(listDisputeQueue(bystander.id)).rejects.toThrow(/do not have access/i);
  });

  it("refuses to let the claimant decide their own claim", async () => {
    const { claimant, reviewer, dispute } = await queued();

    // The case this rule exists for: a staff member who is also the customer.
    await grantOutletStaff(reviewer.id, claimant.id, 19677790);
    await expect(resolveDispute(claimant.id, { disputeId: dispute.id, approve: true })).rejects.toThrow(/your own claim/i);

    // And it is still waiting, not quietly consumed by the failed attempt.
    expect(await listDisputeQueue(reviewer.id)).toHaveLength(1);

    // The claimant is never offered a button that is guaranteed to fail.
    expect(await listDisputeQueue(claimant.id)).toHaveLength(0);
  });

  it("cannot be settled twice, so an approval cannot be replayed", async () => {
    const { reviewer, dispute } = await queued();
    await resolveDispute(reviewer.id, { disputeId: dispute.id, approve: true });

    await expect(resolveDispute(reviewer.id, { disputeId: dispute.id, approve: true })).rejects.toThrow(/already been settled/i);
    expect(await listDisputeQueue(reviewer.id)).toHaveLength(0);
  });

  it("records a decline without paying anything", async () => {
    const { reviewer, dispute } = await queued();
    const settled = await resolveDispute(reviewer.id, {
      disputeId: dispute.id,
      approve: false,
      note: "Rider photo shows the item in the bag.",
    });

    expect(settled.status).toBe("DECLINED");
    expect(settled.refundAmount).toBe(0);
    expect(settled.assessedAmount).toBeGreaterThan(0);
  });

  it("writes an audit trail that cannot afterwards be altered", async () => {
    const { reviewer, dispute } = await queued();
    await resolveDispute(reviewer.id, { disputeId: dispute.id, approve: true });

    const trail = await listAudit(dispute.id);
    expect(trail.map((entry) => entry.action)).toEqual([
      "DISPUTE_REFUNDED",
      "DISPUTE_FILED",
    ]);
    expect(trail.some((entry) => entry.actorId === reviewer.id)).toBe(true);

    // Immutability is enforced by the database, so it holds even for a direct query.
    await expect(run("UPDATE audit_log SET detail = 'tampered'")).rejects.toThrow(/append-only/i);
    await expect(run("DELETE FROM audit_log")).rejects.toThrow(/append-only/i);
    await expect(run("TRUNCATE audit_log")).rejects.toThrow(/append-only/i);
    expect(await listAudit(dispute.id)).toHaveLength(2);
  });
});

describe("Verified reviews", () => {
  it("counts an order or a booking here, and nothing from elsewhere", async () => {
    const user = await registerUser(CREDENTIALS);
    const order = createDemoOrder(CHECKOUT);
    const resId = order.resId;

    expect(await hasVisited(user.id, resId)).toBe(false);

    await saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });
    expect(await hasVisited(user.id, resId)).toBe(true);

    // A visit to one restaurant must not verify a review of another.
    expect(await hasVisited(user.id, 18238278)).toBe(false);
  });

  it("does not verify a different account, or a nonsense restaurant id", async () => {
    const author = await registerUser(CREDENTIALS);
    const stranger = await registerUser({ ...CREDENTIALS, email: "other@krave.test" });
    const order = createDemoOrder(CHECKOUT);
    await saveOrder(author.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });

    expect(await hasVisited(stranger.id, order.resId)).toBe(false);
    expect(await hasVisited(author.id, Number.NaN)).toBe(false);
    expect(await hasVisited(author.id, 1.5)).toBe(false);
  });

  it("verifies from a booking even with no delivery order", async () => {
    const user = await registerUser(CREDENTIALS);
    const reservation = createValidatedReservation({
      resId: 19677790,
      date: "Today, Oct 22",
      timeSlot: "08:30 PM",
      guests: 2,
      guestName: "Rohit",
      guestPhone: "+91 98765 43210",
    });
    await saveReservation(user.id, reservation);

    expect(await hasVisited(user.id, 19677790)).toBe(true);
  });
});

describe("Quote locks", () => {
  const validated = () => validateCheckout(CHECKOUT);
  const issue = (items: CartLineItem[], total: number, now?: Date) => {
    const token = issueQuoteLock(items, total, now);
    if (!token) throw new Error("Expected a lock to be issued outside production.");
    return token;
  };

  it("caps an increase but still passes on a drop", () => {
    const { items, quote } = validated();
    const token = issue(items, quote.grandTotal);

    // Price went up after the lock: the customer pays the locked price.
    const risen = applyQuoteLock(token, items, quote.grandTotal + 500);
    expect(risen.payable).toBe(quote.grandTotal);
    expect(risen.honoured).toBe(true);

    // Price went down: the lock must not hold them to the higher figure.
    const fallen = applyQuoteLock(token, items, quote.grandTotal - 100);
    expect(fallen.payable).toBe(quote.grandTotal - 100);
    expect(fallen.honoured).toBe(false);
  });

  it("refuses a lock that was moved onto a different cart", () => {
    const { items, quote } = validated();
    const token = issue(items, quote.grandTotal);

    const bigger = validateCheckout({
      ...CHECKOUT,
      items: [{ itemId: "ctl_820099425", quantity: 4, optionIds: ["opt_500g"] }],
    });

    const result = applyQuoteLock(token, bigger.items, bigger.quote.grandTotal);
    expect(result.reason).toBe("CART_CHANGED");
    expect(result.payable).toBe(bigger.quote.grandTotal);
  });

  it("expires, and cannot be replayed afterwards", () => {
    const { items, quote } = validated();
    const issuedAt = new Date("2026-01-01T10:00:00.000Z");
    const token = issue(items, quote.grandTotal, issuedAt);

    const justInside = new Date(issuedAt.getTime() + (QUOTE_LOCK_MINUTES - 1) * 60_000);
    expect(applyQuoteLock(token, items, quote.grandTotal + 500, justInside).payable).toBe(
      quote.grandTotal
    );

    const justOutside = new Date(issuedAt.getTime() + (QUOTE_LOCK_MINUTES + 1) * 60_000);
    const expired = applyQuoteLock(token, items, quote.grandTotal + 500, justOutside);
    expect(expired.reason).toBe("EXPIRED");
    expect(expired.payable).toBe(quote.grandTotal + 500);
  });

  it("cannot be forged by editing the amount", () => {
    const { items, quote } = validated();
    const token = issue(items, quote.grandTotal);
    const [body] = token.split(".");

    const claim = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    claim.grandTotal = 1;
    const forgedBody = Buffer.from(JSON.stringify(claim), "utf8").toString("base64url");

    // Re-using the original signature over new contents must not verify.
    const forged = `${forgedBody}.${token.split(".")[1]}`;
    const result = applyQuoteLock(forged, items, quote.grandTotal);
    expect(result.reason).toBe("INVALID");
    expect(result.payable).toBe(quote.grandTotal);
  });

  it("ignores a malformed token rather than failing checkout", () => {
    const { items, quote } = validated();
    for (const bad of ["", "not-a-token", "a.b", "....", "x".repeat(500)]) {
      const result = applyQuoteLock(bad, items, quote.grandTotal);
      expect(result.payable).toBe(quote.grandTotal);
    }
  });
});

describe("Claiming a dine-in bill", () => {
  let staff: AccountUser;
  let outlet: PosOutlet;
  let MENU: PosMenuItem[];

  beforeEach(async () => {
    staff = await registerUser(CREDENTIALS);
    outlet = await seedPosOutlet(staff);
    MENU = outlet.menu;
  });

  function settledTable(tableId = "T1") {
    return settleSession(
      sendPendingToKitchen(
        addItemToSession(
          openTableSession({
            ...outletInput(outlet),
            tableId,
            guestCount: 2,
            serverName: "Asha",
          }),
          { ...MENU[0], price: 1000 },
          1
        )
      ).session,
      "CASH",
      2000
    );
  }

  it("records a settled table once, with a total the server computed", async () => {
    // The terminal claims ₹1000 for a dish the menu prices at MENU[0].price.
    const settled = settledTable();
    const catalogTotal = calculatePosBill({
      ...settled,
      lines: settled.lines.map((line) => ({ ...line, unitPrice: MENU[0].price })),
    }).grandTotal;

    const result = await syncPosState(staff.id, { sessions: [settled], shift: null });
    const code = result.claimCodes[settled.sessionId];
    expect(code).toMatch(/^[2345679BCDFGHJKLMNPQRSTVWXYZ]{10}$/);

    // Syncing again must not mint a second bill or a second code.
    const again = await syncPosState(staff.id, {
      sessions: [{ ...settled, revision: result.sessions[0].revision }],
      shift: null,
    });
    expect(again.claimCodes[settled.sessionId]).toBe(code);
    expect(await one("SELECT COUNT(*)::int AS n FROM dine_in_bills")).toMatchObject({ n: 1 });

    const guest = await registerUser({ email: "guest@krave.test", password: CREDENTIALS.password });
    const bill = await claimDineInBill(guest.id, { code });
    expect(bill.tableId).toBe("T1");
    // The guest is billed the catalog price, not whatever the terminal sent.
    expect(bill.grandTotal).toBe(catalogTotal);
    expect(bill.grandTotal).not.toBe(calculatePosBill(settled).grandTotal);
  });

  it("never hands the claim code back to a claimer", async () => {
    const settled = settledTable();
    const code = (await syncPosState(staff.id, { sessions: [settled], shift: null })).claimCodes[
      settled.sessionId
    ];

    const guest = await registerUser({ email: "guest@krave.test", password: CREDENTIALS.password });
    const claimed = await claimDineInBill(guest.id, { code });

    // Returning it would let a claimed bill be passed on to someone else.
    expect(claimed.claimCode).toBeUndefined();
    expect(JSON.stringify(await listDineInBills(guest.id))).not.toContain(code);
  });

  it("lets only the first holder claim a bill", async () => {
    const settled = settledTable();
    const code = (await syncPosState(staff.id, { sessions: [settled], shift: null })).claimCodes[
      settled.sessionId
    ];

    const first = await registerUser({ email: "first@krave.test", password: CREDENTIALS.password });
    const second = await registerUser({ email: "two@krave.test", password: CREDENTIALS.password });

    await claimDineInBill(first.id, { code });
    await expect(claimDineInBill(second.id, { code })).rejects.toThrow(/not valid or has already/i);

    expect(await listDineInBills(first.id)).toHaveLength(1);
    expect(await listDineInBills(second.id)).toHaveLength(0);
  });

  it("answers identically for unknown, malformed and expired codes", async () => {
    const guest = await registerUser({ email: "guest@krave.test", password: CREDENTIALS.password });
    const settled = settledTable();
    const code = (await syncPosState(staff.id, { sessions: [settled], shift: null })).claimCodes[
      settled.sessionId
    ];

    const message = /not valid or has already been used/i;
    await expect(claimDineInBill(guest.id, { code: "ZZZZZZZZZZ" })).rejects.toThrow(message);
    await expect(claimDineInBill(guest.id, { code: "short" })).rejects.toThrow(message);
    await expect(claimDineInBill(guest.id, {})).rejects.toThrow(message);

    // A bill older than the claim window is refused, and says no more than the rest.
    await run("UPDATE dine_in_bills SET settled_at = $1 WHERE claim_code = $2", [
      new Date(Date.now() - 31 * 86_400_000).toISOString(),
      code,
    ]);
    await expect(claimDineInBill(guest.id, { code })).rejects.toThrow(message);
  });

  it("accepts a code typed in lower case or with stray spacing", async () => {
    const guest = await registerUser({ email: "guest@krave.test", password: CREDENTIALS.password });
    const settled = settledTable();
    const code = (await syncPosState(staff.id, { sessions: [settled], shift: null })).claimCodes[
      settled.sessionId
    ];

    expect((await claimDineInBill(guest.id, { code: `  ${code.toLowerCase()} ` })).tableId).toBe("T1");
  });

  it("does not make an unsettled table claimable", async () => {
    const open = sendPendingToKitchen(
      addItemToSession(
        openTableSession({
          ...outletInput(outlet),
          tableId: "T2",
          guestCount: 2,
          serverName: "Asha",
        }),
        MENU[0],
        1
      )
    ).session;

    const result = await syncPosState(staff.id, { sessions: [open], shift: null });
    expect(result.claimCodes).toEqual({});
    expect(await one("SELECT COUNT(*)::int AS n FROM dine_in_bills")).toMatchObject({ n: 0 });
  });
});

describe("Scheduled windows and notifications", () => {
  const PLACED = new Date("2026-10-22T10:00:00");

  it("resolves each published window to a real time", () => {
    expect(scheduledDueAt("ASAP", PLACED).getTime()).toBe(PLACED.getTime());
    expect(scheduledDueAt("In 1 hour", PLACED).getTime()).toBe(PLACED.getTime() + 3_600_000);
    expect(scheduledDueAt("In 2 hours", PLACED).getTime()).toBe(PLACED.getTime() + 7_200_000);

    const tonight = scheduledDueAt("Tonight, 8:00 PM", PLACED);
    expect(tonight.getHours()).toBe(20);
    expect(tonight.getDate()).toBe(PLACED.getDate());

    // Ordered after 8pm, "tonight" has to mean the next one.
    const lateNight = scheduledDueAt("Tonight, 8:00 PM", new Date("2026-10-22T22:00:00"));
    expect(lateNight.getDate()).toBe(PLACED.getDate() + 1);

    const tomorrow = scheduledDueAt("Tomorrow, 12:30 PM", PLACED);
    expect(tomorrow.getDate()).toBe(PLACED.getDate() + 1);
    expect(tomorrow.getHours()).toBe(12);
    expect(tomorrow.getMinutes()).toBe(30);
  });

  it("starts a scheduled order only once its window arrives", async () => {
    const user = await registerUser(CREDENTIALS);
    const order = createDemoOrder({ ...CHECKOUT, scheduledSlot: "Tomorrow, 12:30 PM" });
    await saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });

    expect(await sweepScheduledOrders(user.id)).toEqual([]);
    expect((await listOrders(user.id))[0].stage).toBe("ORDER_CONFIRMED");

    // Bring the window forward rather than waiting for tomorrow.
    await run("UPDATE orders SET due_at = $1 WHERE id = $2", [
      new Date(Date.now() - 1000).toISOString(),
      order.orderId,
    ]);

    expect(await sweepScheduledOrders(user.id)).toEqual([order.orderId]);
    expect((await listOrders(user.id))[0].stage).toBe("KITCHEN_PREPARING");
    expect((await listNotifications(user.id))[0].title).toMatch(/scheduled order has started/i);

    // A second sweep must not re-announce or re-advance it.
    expect(await sweepScheduledOrders(user.id)).toEqual([]);
    expect(await listNotifications(user.id)).toHaveLength(1);
  });

  it("does not announce an ASAP order as scheduled", async () => {
    const user = await registerUser(CREDENTIALS);
    const order = createDemoOrder(CHECKOUT);
    await saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });

    expect(await sweepScheduledOrders(user.id)).toEqual([order.orderId]);
    expect(await listNotifications(user.id)).toHaveLength(0);
  });

  it("keeps each account's notifications to itself and tracks read state", async () => {
    const owner = await registerUser(CREDENTIALS);
    const other = await registerUser({ email: "other@krave.test", password: CREDENTIALS.password });

    await addNotification(owner.id, "ORDER", "Order confirmed", "No payment was collected.");
    await addNotification(owner.id, "RESERVATION", "Table confirmed", "Tonight at 7:30 PM.");

    expect(await listNotifications(owner.id)).toHaveLength(2);
    expect(await listNotifications(other.id)).toHaveLength(0);
    expect((await listNotifications(owner.id)).every((entry) => !entry.read)).toBe(true);

    await markNotificationsRead(owner.id);
    expect((await listNotifications(owner.id)).every((entry) => entry.read)).toBe(true);

    await clearNotifications(other.id);
    expect(await listNotifications(owner.id)).toHaveLength(2);

    await clearNotifications(owner.id);
    expect(await listNotifications(owner.id)).toHaveLength(0);
  });
});

});
