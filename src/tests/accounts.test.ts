import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { useTestDb } from "@/lib/server/db";
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
  listDisputes,
} from "@/lib/server/disputeStore";
import {
  listUnavailableItems,
  pruneUnknownAvailability,
  setDishAvailability,
} from "@/lib/server/menuStore";
import { loadPosState, syncPosState } from "@/lib/server/posStore";
import {
  addCustomItemToSession,
  addItemToSession,
  calculatePosBill,
  getPosMenu,
  getPosOutlets,
  openShift,
  openTableSession,
  sendPendingToKitchen,
  settleSession,
} from "@/lib/pos/posEngine";
import { RESTAURANTS_DATA } from "@/data/zomatoReconstructedData";

const CREDENTIALS = { email: "Chef@Krave.test", password: "correct-horse-battery" };
const CHECKOUT = {
  items: [{ itemId: "ctl_820099425", quantity: 1, optionIds: ["opt_500g"] }],
  addressId: "addr_cp_514",
  paymentMethod: DEMO_PAYMENT_METHODS[0],
  couponCode: "KRAVE50",
  isGoldMember: true,
  riderTip: 20,
};

let db: DatabaseSync;

beforeEach(() => {
  db = new DatabaseSync(":memory:");
  useTestDb(db);
});

afterEach(() => {
  db.close();
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
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(user.id) as Record<string, unknown>;

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
    const { token } = createSession(user.id);

    const stored = db.prepare("SELECT token_hash FROM sessions").get() as Record<string, unknown>;
    expect(String(stored.token_hash)).not.toBe(token);

    expect(getUserForToken(token)?.id).toBe(user.id);
    expect(getUserForToken("not-a-token")).toBeNull();
    expect(getUserForToken(undefined)).toBeNull();

    destroySession(token);
    expect(getUserForToken(token)).toBeNull();
  });

  it("rejects an expired session", async () => {
    const user = await registerUser(CREDENTIALS);
    const { token } = createSession(user.id);
    db.prepare("UPDATE sessions SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    expect(getUserForToken(token)).toBeNull();
  });

  it("rebuilds a stored order from the catalog rather than from stored totals", async () => {
    const user = await registerUser(CREDENTIALS);
    const order = createDemoOrder(CHECKOUT);
    saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: "key-1" });

    // Tamper with the stored total the way a compromised row would.
    db.prepare("UPDATE orders SET grand_total = 1 WHERE id = ?").run(order.orderId);

    const [restored] = listOrders(user.id);
    expect(restored.orderId).toBe(order.orderId);
    expect(restored.quote.grandTotal).toBe(order.quote.grandTotal);
    expect(restored.quote.grandTotal).not.toBe(1);
    expect(restored.items[0].unitPrice).toBe(order.items[0].unitPrice);
  });

  it("replays the same idempotency key instead of writing a second order", async () => {
    const user = await registerUser(CREDENTIALS);
    const order = createDemoOrder(CHECKOUT);
    saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: "key-1" });

    expect(findOrderByIdempotencyKey(user.id, "key-1")?.orderId).toBe(order.orderId);
    expect(findOrderByIdempotencyKey(user.id, "key-2")).toBeNull();
    expect(findOrderByIdempotencyKey(user.id, null)).toBeNull();

    expect(() =>
      saveOrder(user.id, createDemoOrder(CHECKOUT), {
        addressId: CHECKOUT.addressId,
        idempotencyKey: "key-1",
      })
    ).toThrow();
    expect(listOrders(user.id)).toHaveLength(1);
  });

  it("keeps one account's orders out of another's", async () => {
    const owner = await registerUser(CREDENTIALS);
    const other = await registerUser({ email: "other@krave.test", password: CREDENTIALS.password });
    const order = createDemoOrder(CHECKOUT);
    saveOrder(owner.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });

    expect(listOrders(other.id)).toHaveLength(0);
    expect(() => deleteOrder(other.id, order.orderId)).toThrow();
    expect(() => advanceOrderStage(other.id, order.orderId, "KITCHEN_PREPARING")).toThrow();
    expect(listOrders(owner.id)).toHaveLength(1);
  });

  it("cancels only before the kitchen stage, the same rule the browser uses", async () => {
    const user = await registerUser(CREDENTIALS);
    const order = createDemoOrder(CHECKOUT);
    saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });

    advanceOrderStage(user.id, order.orderId, "KITCHEN_PREPARING");
    expect(listOrders(user.id)[0].stage).toBe("KITCHEN_PREPARING");
    expect(() => deleteOrder(user.id, order.orderId)).toThrow();

    advanceOrderStage(user.id, order.orderId, "ORDER_CONFIRMED");
    deleteOrder(user.id, order.orderId);
    expect(listOrders(user.id)).toHaveLength(0);
    // Lines are removed with the order rather than left behind.
    expect(db.prepare("SELECT COUNT(*) AS n FROM order_lines").get()).toMatchObject({ n: 0 });
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
    saveReservation(user.id, reservation);

    const [restored] = listReservations(user.id);
    expect(restored.bookingId).toBe(reservation.bookingId);
    expect(restored.guests).toBe(2);

    db.prepare("UPDATE reservations SET time_slot = ? WHERE id = ?").run("03:00 AM", reservation.bookingId);
    expect(listReservations(user.id)).toHaveLength(0);
  });

  it("keeps bookmarks to known restaurants and replaces the whole set", async () => {
    const user = await registerUser(CREDENTIALS);
    const known = RESTAURANTS_DATA[0].resId;

    expect(setBookmarks(user.id, [known, known, 404404, "nope"])).toEqual([known]);
    expect(listBookmarks(user.id)).toEqual([known]);
    expect(setBookmarks(user.id, [])).toEqual([]);
    expect(listBookmarks(user.id)).toEqual([]);
    expect(() => setBookmarks(user.id, "all")).toThrow();
  });

  it("persists a membership change", async () => {
    const user = await registerUser(CREDENTIALS);
    setGoldMembership(user.id, true);
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
  });

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
    const { token: sessionToken } = createSession(user.id);
    expect(getUserForToken(sessionToken)?.id).toBe(user.id);

    const reset = createPasswordReset({ email: CREDENTIALS.email })!;
    expect(reset.token.length).toBeGreaterThan(20);
    // The raw token is never stored.
    const stored = db.prepare("SELECT token_hash FROM password_resets").get() as Record<string, unknown>;
    expect(String(stored.token_hash)).not.toBe(reset.token);

    await resetPassword(reset.token, "a-brand-new-password");

    expect(getUserForToken(sessionToken)).toBeNull();
    await expect(verifyCredentials(CREDENTIALS)).rejects.toThrow();
    await expect(
      verifyCredentials({ email: CREDENTIALS.email, password: "a-brand-new-password" })
    ).resolves.toMatchObject({ id: user.id });

    await expect(resetPassword(reset.token, "yet-another-password")).rejects.toThrow();
  });

  it("refuses an expired, unknown or weak reset", async () => {
    await registerUser(CREDENTIALS);
    const reset = createPasswordReset({ email: CREDENTIALS.email })!;

    await expect(resetPassword(reset.token, "short")).rejects.toThrow();
    await expect(resetPassword("not-a-real-token-value", "a-brand-new-password")).rejects.toThrow();

    db.prepare("UPDATE password_resets SET expires_at = ?").run("2000-01-01T00:00:00.000Z");
    await expect(resetPassword(reset.token, "a-brand-new-password")).rejects.toThrow(/expired/i);
  });

  it("does not reveal whether an email has an account", () => {
    expect(createPasswordReset({ email: "ghost@krave.test" })).toBeNull();
    expect(createPasswordReset({ email: "not-an-email" })).toBeNull();
  });

  it("lets a locked-out user back in after completing a reset", async () => {
    await registerUser(CREDENTIALS);
    for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt += 1) {
      await expect(
        verifyCredentials({ email: CREDENTIALS.email, password: "bad-password-3" }, "4.4.4.4")
      ).rejects.toThrow();
    }
    await expect(verifyCredentials(CREDENTIALS, "4.4.4.4")).rejects.toThrow(/too many/i);

    const reset = createPasswordReset({ email: CREDENTIALS.email })!;
    await resetPassword(reset.token, "a-brand-new-password", "4.4.4.4");

    // Both the account lockout and the requesting client's lockout are lifted.
    await expect(
      verifyCredentials({ email: CREDENTIALS.email, password: "a-brand-new-password" }, "4.4.4.4")
    ).resolves.toMatchObject({ email: "chef@krave.test" });
  });

  it("signs out every device at once", async () => {
    const user = await registerUser(CREDENTIALS);
    const first = createSession(user.id);
    const second = createSession(user.id);

    revokeAllSessions(user.id);
    expect(getUserForToken(first.token)).toBeNull();
    expect(getUserForToken(second.token)).toBeNull();
  });
});

describe("Dine-in terminal sync", () => {
  const OUTLET_ID = getPosOutlets()[0].outletId;
  const MENU = getPosMenu(OUTLET_ID);

  function firedTable(tableId = "T1") {
    return sendPendingToKitchen(
      addItemToSession(
        openTableSession({
          outletId: OUTLET_ID,
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
    const user = await registerUser(CREDENTIALS);
    const shift = openShift({ outletId: OUTLET_ID, openedBy: "Meera", openingCash: 2000 });
    const session = firedTable();

    const result = syncPosState(user.id, { sessions: [session], shift });
    expect(result.rejected).toEqual([]);
    expect(result.sessions).toHaveLength(1);
    expect(result.shift?.shiftId).toBe(shift.shiftId);

    const [stored] = result.sessions;
    expect(stored.sessionId).toBe(session.sessionId);
    expect(stored.tickets).toHaveLength(1);
    expect(stored.tickets[0].lines[0].quantity).toBe(2);
    expect(stored.lines[0].kotNumber).toBe(1);
    expect(calculatePosBill(stored).grandTotal).toBe(calculatePosBill(session).grandTotal);

    expect(loadPosState(user.id).sessions).toHaveLength(1);
  });

  it("reprices catalog dishes from the catalog instead of trusting the terminal", async () => {
    const user = await registerUser(CREDENTIALS);
    const session = firedTable();
    // An offline terminal could send anything; the money must not come from it.
    const tampered = {
      ...session,
      lines: session.lines.map((line) => ({ ...line, unitPrice: 1 })),
    };

    const [stored] = syncPosState(user.id, { sessions: [tampered], shift: null }).sessions;
    expect(stored.lines[0].unitPrice).toBe(MENU[0].price);
    expect(calculatePosBill(stored).grandTotal).toBe(calculatePosBill(session).grandTotal);
  });

  it("keeps an operator's off-menu price but refuses an impossible one", async () => {
    const user = await registerUser(CREDENTIALS);
    const custom = sendPendingToKitchen(
      addCustomItemToSession(
        openTableSession({
          outletId: OUTLET_ID,
          tableId: "T2",
          guestCount: 2,
          serverName: "Asha",
        }),
        { name: "Chef Special Soda", price: 180, dietary: "veg", quantity: 1 }
      )
    ).session;

    const [stored] = syncPosState(user.id, { sessions: [custom], shift: null }).sessions;
    expect(stored.lines[0].unitPrice).toBe(180);

    const absurd = {
      ...custom,
      lines: custom.lines.map((line) => ({ ...line, unitPrice: 99999999 })),
    };
    const result = syncPosState(user.id, { sessions: [absurd], shift: null });
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].sessionId).toBe(custom.sessionId);
    // An unusable price is permanent, not something reloading would fix.
    expect(result.conflicts).toEqual([]);
  });

  it("reports the settled total it computed rather than one the terminal supplied", async () => {
    const user = await registerUser(CREDENTIALS);
    const settled = settleSession(firedTable(), "CASH", 100000);
    const expected = calculatePosBill(settled).grandTotal;

    const result = syncPosState(user.id, { sessions: [settled], shift: null });
    expect(result.settledTotal).toBe(expected);
    expect(result.sessions[0].payment?.method).toBe("CASH");
  });

  it("keeps one account's floor out of another's", async () => {
    const owner = await registerUser(CREDENTIALS);
    const other = await registerUser({ email: "other@krave.test", password: CREDENTIALS.password });
    syncPosState(owner.id, { sessions: [firedTable()], shift: null });

    expect(loadPosState(other.id).sessions).toHaveLength(0);
    expect(loadPosState(owner.id).sessions).toHaveLength(1);
  });

  it("replaces the stored floor on each sync instead of duplicating it", async () => {
    const user = await registerUser(CREDENTIALS);
    const session = firedTable();

    syncPosState(user.id, { sessions: [session], shift: null });
    const second = syncPosState(user.id, { sessions: [session], shift: null });

    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0].lines).toHaveLength(1);
    expect(second.sessions[0].tickets).toHaveLength(1);
  });

  it("drops a malformed table rather than failing the whole sync", async () => {
    const user = await registerUser(CREDENTIALS);
    const good = firedTable();
    const result = syncPosState(user.id, {
      sessions: [good, { sessionId: "not-a-session" }, null],
      shift: null,
    });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].sessionId).toBe(good.sessionId);
  });

  it("rejects a second terminal's stale write instead of overwriting the first", async () => {
    const user = await registerUser(CREDENTIALS);
    const session = firedTable();

    // Terminal A syncs and learns the new revision.
    const first = syncPosState(user.id, { sessions: [session], shift: null });
    const revisionA = first.sessions[0].revision;
    expect(revisionA).toBe(1);

    // Terminal A adds a dish and syncs again, which moves the revision on.
    const advanced = addItemToSession({ ...session, revision: revisionA }, MENU[1], 1);
    const second = syncPosState(user.id, { sessions: [advanced], shift: null });
    expect(second.conflicts).toEqual([]);
    expect(second.sessions[0].revision).toBe(2);

    // Terminal B still believes it is on the old revision; its write must be refused.
    const stale = addItemToSession({ ...session, revision: revisionA }, MENU[2], 5);
    const third = syncPosState(user.id, { sessions: [stale], shift: null });
    expect(third.conflicts).toHaveLength(1);
    expect(third.conflicts[0].reason).toMatch(/another terminal/i);
    // A stale edit is recoverable by reloading, so it is not a hard rejection.
    expect(third.rejected).toEqual([]);

    // The first terminal's work is untouched.
    expect(third.sessions[0].revision).toBe(2);
    expect(third.sessions[0].lines).toHaveLength(2);
    expect(third.sessions[0].lines.some((line) => line.quantity === 5)).toBe(false);
  });
});

describe("Outlet-wide availability", () => {
  const DISH_ID = "ctl_820099425";

  it("takes a dish off for the whole outlet, not just the marking device", async () => {
    const staff = await registerUser(CREDENTIALS);
    expect(listUnavailableItems()).toEqual([]);

    const marked = setDishAvailability(staff.id, { itemId: DISH_ID, unavailable: true });
    expect(marked.unavailableItemIds).toContain(DISH_ID);

    // A second operator, and any anonymous reader, sees the same list.
    const other = await registerUser({ email: "second@krave.test", password: CREDENTIALS.password });
    expect(listUnavailableItems()).toContain(DISH_ID);

    setDishAvailability(other.id, { itemId: DISH_ID, unavailable: false });
    expect(listUnavailableItems()).toEqual([]);
  });

  it("derives the outlet from the catalog rather than the caller", async () => {
    const staff = await registerUser(CREDENTIALS);
    setDishAvailability(staff.id, { itemId: DISH_ID, unavailable: true });

    const owningOutlet = RESTAURANTS_DATA.find((restaurant) =>
      restaurant.menus.some((menu) =>
        menu.categories.some((category) => category.items.some((item) => item.id === DISH_ID))
      )
    )!;
    expect(listUnavailableItems(owningOutlet.resId)).toEqual([DISH_ID]);

    const otherOutlet = RESTAURANTS_DATA.find(
      (restaurant) => restaurant.resId !== owningOutlet.resId
    )!;
    expect(listUnavailableItems(otherOutlet.resId)).toEqual([]);
  });

  it("refuses an unknown dish or a missing flag", async () => {
    const staff = await registerUser(CREDENTIALS);
    expect(() => setDishAvailability(staff.id, { itemId: "ghost", unavailable: true })).toThrow();
    expect(() => setDishAvailability(staff.id, { itemId: DISH_ID })).toThrow();
    expect(() =>
      setDishAvailability(staff.id, { itemId: DISH_ID, unavailable: "yes" })
    ).toThrow();
  });

  it("blocks checkout for a dish that is off, without breaking order replay", async () => {
    const user = await registerUser(CREDENTIALS);
    const validated = createDemoOrder(CHECKOUT);

    // Nothing is off yet, so the cart passes.
    expect(() => assertItemsAvailable(validated.items, [])).not.toThrow();

    setDishAvailability(user.id, { itemId: DISH_ID, unavailable: true });
    expect(() => assertItemsAvailable(validated.items, listUnavailableItems())).toThrow(
      /sold out/i
    );

    // An order placed before it sold out must still read back from history.
    saveOrder(user.id, validated, { addressId: CHECKOUT.addressId, idempotencyKey: null });
    expect(listOrders(user.id)).toHaveLength(1);
  });

  it("drops a stale mark for a dish the catalog no longer has", async () => {
    const staff = await registerUser(CREDENTIALS);
    setDishAvailability(staff.id, { itemId: DISH_ID, unavailable: true });
    db.prepare("INSERT INTO dish_availability VALUES (?, ?, ?, ?)").run(
      1,
      "ctl_removed_dish",
      new Date().toISOString(),
      staff.id
    );

    expect(pruneUnknownAvailability()).toBe(1);
    expect(listUnavailableItems()).toEqual([DISH_ID]);
  });
});

describe("Kitchen tickets and prep time", () => {
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

  it("puts a placed order on the outlet's counter without any customer identity", () => {
    const order = placeOrder({ flags: ["ALLERGY"], allergyNote: "severe peanut allergy" });
    createDeliveryTicket(order);

    const [ticket] = listDeliveryTickets(order.resId);
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
    expect(listDeliveryTickets(18238278)).toHaveLength(0);
  });

  it("is idempotent, so a retried order never double-prints", () => {
    const order = placeOrder();
    createDeliveryTicket(order);
    createDeliveryTicket(order);
    expect(listDeliveryTickets(order.resId)).toHaveLength(1);
  });

  it("carries each dish's allergen declaration, keeping silence distinguishable", () => {
    const order = placeOrder({ flags: ["ALLERGY"], allergyNote: "severe peanut allergy" });
    createDeliveryTicket(order);

    const [ticket] = listDeliveryTickets(order.resId);
    const declared = order.items[0].item.allergens ?? null;

    // null must survive the round trip: an undeclared dish must not arrive as "none".
    expect(ticket.lines[0].allergens).toEqual(declared);
    if (declared === null) {
      expect(ticket.lines[0].allergens).not.toEqual([]);
    }
  });

  it("marks only genuinely critical handling as critical", () => {
    const relaxed = placeOrder({ flags: ["NO_CUTLERY", "LESS_SPICY"] });
    createDeliveryTicket(relaxed);
    expect(listDeliveryTickets(relaxed.resId)[0].critical).toBe(false);
  });

  it("moves a ticket forward one step at a time and never backwards", () => {
    const order = placeOrder();
    createDeliveryTicket(order);

    expect(() => advanceDeliveryTicket(order.orderId, "READY")).toThrow(/one step/i);
    expect(() => advanceDeliveryTicket("KRV-unknown", "ACCEPTED")).toThrow(/not on this counter/i);
    expect(() => advanceDeliveryTicket(order.orderId, "COOKED")).toThrow();

    const accepted = advanceDeliveryTicket(order.orderId, "ACCEPTED");
    expect(accepted.status).toBe("ACCEPTED");
    expect(accepted.acceptedAt).not.toBeNull();

    const ready = advanceDeliveryTicket(order.orderId, "READY");
    expect(ready.status).toBe("READY");
    expect(ready.prepMinutes).not.toBeNull();

    // Already finished; it cannot be reopened or re-advanced.
    expect(() => advanceDeliveryTicket(order.orderId, "READY")).toThrow();
    expect(() => advanceDeliveryTicket(order.orderId, "ACCEPTED")).toThrow();
  });

  it("reports prep time only once there are enough samples to mean anything", () => {
    const outletId = RESTAURANTS_DATA[0].resId;
    expect(prepTimeStats(outletId)).toEqual({
      sampleSize: 0,
      medianMinutes: null,
      p90Minutes: null,
    });

    // Three finished tickets is not a distribution.
    for (let i = 0; i < 3; i += 1) {
      const order = { ...placeOrder(), orderId: `KRV-sample-${i}` };
      createDeliveryTicket(order);
      advanceDeliveryTicket(order.orderId, "ACCEPTED");
      advanceDeliveryTicket(order.orderId, "READY");
    }
    expect(prepTimeStats(outletId).medianMinutes).toBeNull();
    expect(prepTimeStats(outletId).sampleSize).toBe(3);

    // With a real sample it reports a measured spread, not one padded figure.
    for (let i = 3; i < 9; i += 1) {
      const order = { ...placeOrder(), orderId: `KRV-sample-${i}` };
      createDeliveryTicket(order);
      advanceDeliveryTicket(order.orderId, "ACCEPTED");
      advanceDeliveryTicket(order.orderId, "READY");
      db.prepare("UPDATE delivery_tickets SET ready_at = ? WHERE order_id = ?").run(
        new Date(Date.parse(order.placedAt) + i * 60_000).toISOString(),
        order.orderId
      );
      db.prepare("UPDATE delivery_tickets SET accepted_at = ? WHERE order_id = ?").run(
        order.placedAt,
        order.orderId
      );
    }

    const stats = prepTimeStats(outletId);
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
    saveOrder(user.id, order, { addressId: checkout.addressId, idempotencyKey: null });
    advanceOrderStage(user.id, order.orderId, "ARRIVED");
    return { user, order };
  }

  const line = (order: ReturnType<typeof createDemoOrder>, quantity = 1) => [
    { itemId: order.items[0].item.id, quantity },
  ];

  it("refunds what was paid, not the menu price", async () => {
    const { user, order } = await delivered(CHECKOUT);
    const dispute = fileDispute(user.id, {
      orderId: order.orderId,
      reason: "MISSING_ITEM",
      lines: line(order),
    });

    // This order is above the automatic ceiling, so it is reviewed rather than paid out.
    expect(dispute.status).toBe("UNDER_REVIEW");

    const cheap = await delivered(CHEAP_CHECKOUT, "cheap@krave.test");
    const paid = fileDispute(cheap.user.id, {
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
    const dispute = fileDispute(user.id, {
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
    fileDispute(user.id, { orderId: order.orderId, reason: "MISSING_ITEM", lines: line(order) });
    expect(() =>
      fileDispute(user.id, { orderId: order.orderId, reason: "MISSING_ITEM", lines: line(order) })
    ).toThrow(/already raised/i);
    expect(listDisputes(user.id)).toHaveLength(1);
  });

  it("refuses claims for items or quantities that were never ordered", async () => {
    const { user, order } = await delivered();

    expect(() =>
      fileDispute(user.id, {
        orderId: order.orderId,
        reason: "MISSING_ITEM",
        lines: [{ itemId: "ctl_820099426", quantity: 1 }],
      })
    ).toThrow(/not on this order/i);

    expect(() =>
      fileDispute(user.id, {
        orderId: order.orderId,
        reason: "MISSING_ITEM",
        lines: line(order, order.items[0].quantity + 1),
      })
    ).toThrow(/more of an item than you ordered/i);
  });

  it("refuses another account's order and an undelivered one", async () => {
    const { order } = await delivered();
    const stranger = await registerUser({ ...CREDENTIALS, email: "stranger@krave.test" });
    expect(() =>
      fileDispute(stranger.id, {
        orderId: order.orderId,
        reason: "MISSING_ITEM",
        lines: line(order),
      })
    ).toThrow(/not in your history/i);

    const user = await registerUser({ ...CREDENTIALS, email: "pending@krave.test" });
    const pending = createDemoOrder(CHEAP_CHECKOUT);
    saveOrder(user.id, pending, { addressId: CHEAP_CHECKOUT.addressId, idempotencyKey: null });
    expect(() =>
      fileDispute(user.id, {
        orderId: pending.orderId,
        reason: "MISSING_ITEM",
        lines: line(pending),
      })
    ).toThrow(/been delivered/i);
  });

  it("closes the window after the stated deadline", async () => {
    const { user, order } = await delivered();
    const tooLate = new Date(
      Date.parse(order.placedAt) + (DISPUTE_WINDOW_HOURS + 1) * 3_600_000
    );
    expect(() =>
      fileDispute(
        user.id,
        { orderId: order.orderId, reason: "MISSING_ITEM", lines: line(order) },
        tooLate
      )
    ).toThrow(/Claims close/i);
  });

  it("stops refunding automatically once an account keeps claiming", async () => {
    const user = await registerUser(CREDENTIALS);

    const statuses: string[] = [];
    for (let attempt = 0; attempt < AUTO_REFUND_RECENT_LIMIT + 1; attempt += 1) {
      const order = createDemoOrder(CHEAP_CHECKOUT);
      saveOrder(user.id, order, { addressId: CHEAP_CHECKOUT.addressId, idempotencyKey: null });
      advanceOrderStage(user.id, order.orderId, "ARRIVED");
      statuses.push(
        fileDispute(user.id, {
          orderId: order.orderId,
          reason: "MISSING_ITEM",
          lines: line(order),
        }).status
      );
    }

    expect(statuses.slice(0, AUTO_REFUND_RECENT_LIMIT)).toEqual(
      Array(AUTO_REFUND_RECENT_LIMIT).fill("AUTO_REFUNDED")
    );
    expect(statuses.at(-1)).toBe("UNDER_REVIEW");
  });

  it("sends quality reports to a person, with a stated deadline", async () => {
    const { user, order } = await delivered();
    const dispute = fileDispute(user.id, {
      orderId: order.orderId,
      reason: "QUALITY",
      lines: line(order),
    });

    expect(dispute.status).toBe("UNDER_REVIEW");
    expect(dispute.refundAmount).toBe(0);
    expect(dispute.reviewDueAt).not.toBeNull();
  });
});

describe("Verified reviews", () => {
  it("counts an order or a booking here, and nothing from elsewhere", async () => {
    const user = await registerUser(CREDENTIALS);
    const order = createDemoOrder(CHECKOUT);
    const resId = order.resId;

    expect(hasVisited(user.id, resId)).toBe(false);

    saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });
    expect(hasVisited(user.id, resId)).toBe(true);

    // A visit to one restaurant must not verify a review of another.
    expect(hasVisited(user.id, 18238278)).toBe(false);
  });

  it("does not verify a different account, or a nonsense restaurant id", async () => {
    const author = await registerUser(CREDENTIALS);
    const stranger = await registerUser({ ...CREDENTIALS, email: "other@krave.test" });
    const order = createDemoOrder(CHECKOUT);
    saveOrder(author.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });

    expect(hasVisited(stranger.id, order.resId)).toBe(false);
    expect(hasVisited(author.id, Number.NaN)).toBe(false);
    expect(hasVisited(author.id, 1.5)).toBe(false);
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
    saveReservation(user.id, reservation);

    expect(hasVisited(user.id, 19677790)).toBe(true);
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
  const OUTLET_ID = getPosOutlets()[0].outletId;
  const MENU = getPosMenu(OUTLET_ID);

  function settledTable(tableId = "T1") {
    return settleSession(
      sendPendingToKitchen(
        addItemToSession(
          openTableSession({
            outletId: OUTLET_ID,
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
    const staff = await registerUser(CREDENTIALS);
    // The terminal claims ₹1000 for a dish the catalog prices at MENU[0].price.
    const settled = settledTable();
    const catalogTotal = calculatePosBill({
      ...settled,
      lines: settled.lines.map((line) => ({ ...line, unitPrice: MENU[0].price })),
    }).grandTotal;

    const result = syncPosState(staff.id, { sessions: [settled], shift: null });
    const code = result.claimCodes[settled.sessionId];
    expect(code).toMatch(/^[2345679BCDFGHJKLMNPQRSTVWXYZ]{10}$/);

    // Syncing again must not mint a second bill or a second code.
    const again = syncPosState(staff.id, {
      sessions: [{ ...settled, revision: result.sessions[0].revision }],
      shift: null,
    });
    expect(again.claimCodes[settled.sessionId]).toBe(code);
    expect(db.prepare("SELECT COUNT(*) AS n FROM dine_in_bills").get()).toMatchObject({ n: 1 });

    const guest = await registerUser({ email: "guest@krave.test", password: CREDENTIALS.password });
    const bill = claimDineInBill(guest.id, { code });
    expect(bill.tableId).toBe("T1");
    // The guest is billed the catalog price, not whatever the terminal sent.
    expect(bill.grandTotal).toBe(catalogTotal);
    expect(bill.grandTotal).not.toBe(calculatePosBill(settled).grandTotal);
  });

  it("never hands the claim code back to a claimer", async () => {
    const staff = await registerUser(CREDENTIALS);
    const settled = settledTable();
    const code = syncPosState(staff.id, { sessions: [settled], shift: null }).claimCodes[
      settled.sessionId
    ];

    const guest = await registerUser({ email: "guest@krave.test", password: CREDENTIALS.password });
    const claimed = claimDineInBill(guest.id, { code });

    // Returning it would let a claimed bill be passed on to someone else.
    expect(claimed.claimCode).toBeUndefined();
    expect(JSON.stringify(listDineInBills(guest.id))).not.toContain(code);
  });

  it("lets only the first holder claim a bill", async () => {
    const staff = await registerUser(CREDENTIALS);
    const settled = settledTable();
    const code = syncPosState(staff.id, { sessions: [settled], shift: null }).claimCodes[
      settled.sessionId
    ];

    const first = await registerUser({ email: "first@krave.test", password: CREDENTIALS.password });
    const second = await registerUser({ email: "two@krave.test", password: CREDENTIALS.password });

    claimDineInBill(first.id, { code });
    expect(() => claimDineInBill(second.id, { code })).toThrow(/not valid or has already/i);

    expect(listDineInBills(first.id)).toHaveLength(1);
    expect(listDineInBills(second.id)).toHaveLength(0);
  });

  it("answers identically for unknown, malformed and expired codes", async () => {
    const staff = await registerUser(CREDENTIALS);
    const guest = await registerUser({ email: "guest@krave.test", password: CREDENTIALS.password });
    const settled = settledTable();
    const code = syncPosState(staff.id, { sessions: [settled], shift: null }).claimCodes[
      settled.sessionId
    ];

    const message = /not valid or has already been used/i;
    expect(() => claimDineInBill(guest.id, { code: "ZZZZZZZZZZ" })).toThrow(message);
    expect(() => claimDineInBill(guest.id, { code: "short" })).toThrow(message);
    expect(() => claimDineInBill(guest.id, {})).toThrow(message);

    // A bill older than the claim window is refused, and says no more than the rest.
    db.prepare("UPDATE dine_in_bills SET settled_at = ? WHERE claim_code = ?").run(
      new Date(Date.now() - 31 * 86_400_000).toISOString(),
      code
    );
    expect(() => claimDineInBill(guest.id, { code })).toThrow(message);
  });

  it("accepts a code typed in lower case or with stray spacing", async () => {
    const staff = await registerUser(CREDENTIALS);
    const guest = await registerUser({ email: "guest@krave.test", password: CREDENTIALS.password });
    const settled = settledTable();
    const code = syncPosState(staff.id, { sessions: [settled], shift: null }).claimCodes[
      settled.sessionId
    ];

    expect(claimDineInBill(guest.id, { code: `  ${code.toLowerCase()} ` }).tableId).toBe("T1");
  });

  it("does not make an unsettled table claimable", async () => {
    const staff = await registerUser(CREDENTIALS);
    const open = sendPendingToKitchen(
      addItemToSession(
        openTableSession({
          outletId: OUTLET_ID,
          tableId: "T2",
          guestCount: 2,
          serverName: "Asha",
        }),
        MENU[0],
        1
      )
    ).session;

    const result = syncPosState(staff.id, { sessions: [open], shift: null });
    expect(result.claimCodes).toEqual({});
    expect(db.prepare("SELECT COUNT(*) AS n FROM dine_in_bills").get()).toMatchObject({ n: 0 });
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
    saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });

    expect(sweepScheduledOrders(user.id)).toEqual([]);
    expect(listOrders(user.id)[0].stage).toBe("ORDER_CONFIRMED");

    // Bring the window forward rather than waiting for tomorrow.
    db.prepare("UPDATE orders SET due_at = ? WHERE id = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      order.orderId
    );

    expect(sweepScheduledOrders(user.id)).toEqual([order.orderId]);
    expect(listOrders(user.id)[0].stage).toBe("KITCHEN_PREPARING");
    expect(listNotifications(user.id)[0].title).toMatch(/scheduled order has started/i);

    // A second sweep must not re-announce or re-advance it.
    expect(sweepScheduledOrders(user.id)).toEqual([]);
    expect(listNotifications(user.id)).toHaveLength(1);
  });

  it("does not announce an ASAP order as scheduled", async () => {
    const user = await registerUser(CREDENTIALS);
    const order = createDemoOrder(CHECKOUT);
    saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });

    expect(sweepScheduledOrders(user.id)).toEqual([order.orderId]);
    expect(listNotifications(user.id)).toHaveLength(0);
  });

  it("keeps each account's notifications to itself and tracks read state", async () => {
    const owner = await registerUser(CREDENTIALS);
    const other = await registerUser({ email: "other@krave.test", password: CREDENTIALS.password });

    addNotification(owner.id, "ORDER", "Order confirmed", "No payment was collected.");
    addNotification(owner.id, "RESERVATION", "Table confirmed", "Tonight at 7:30 PM.");

    expect(listNotifications(owner.id)).toHaveLength(2);
    expect(listNotifications(other.id)).toHaveLength(0);
    expect(listNotifications(owner.id).every((entry) => !entry.read)).toBe(true);

    markNotificationsRead(owner.id);
    expect(listNotifications(owner.id).every((entry) => entry.read)).toBe(true);

    clearNotifications(other.id);
    expect(listNotifications(owner.id)).toHaveLength(2);

    clearNotifications(owner.id);
    expect(listNotifications(owner.id)).toHaveLength(0);
  });
});
