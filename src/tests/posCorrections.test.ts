import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerUser } from "@/lib/server/auth";
import { one } from "@/lib/server/pg";
import { claimDineInBill, getClaimCode } from "@/lib/server/dineInStore";
import { confirmPosOwnerPin, POS_PIN_MISSING, setPosOwnerPin } from "@/lib/server/posOwnerPin";
import { syncPosState } from "@/lib/server/posStore";
import {
  addItemToSession,
  calculatePosBill,
  changeSettledPayment,
  openTableSession,
  reopenSettledSession,
  restorePosSessions,
  sendPendingToKitchen,
  setTableServer,
  settleSession,
  summarizeShift,
  type PosTableSession,
} from "@/lib/pos/posEngine";
import { MENU, OUTLET } from "./support/posFixture";
import { seedPosOutlet } from "./support/posRestaurant";
import {
  hasTestDatabase,
  resetTestDatabase,
  startTestDatabase,
  stopTestDatabase,
} from "./support/testDb";

function paidTable(method: "CASH" | "UPI" = "CASH", shiftId: string | null = null): PosTableSession {
  let session = openTableSession({
    ...OUTLET,
    tableId: "T1",
    guestCount: 2,
    serverName: "Asha",
    shiftId,
  });
  session = sendPendingToKitchen(addItemToSession(session, MENU[0], 1)).session;
  const total = calculatePosBill(session).grandTotal;
  return settleSession(session, method, method === "CASH" ? total + 50 : 0);
}

describe("correcting the waiter on a table", () => {
  it("renames the waiter for the rest of the meal, but not on tickets already sent", () => {
    let session = openTableSession({ ...OUTLET, tableId: "T1", guestCount: 2, serverName: "Asha" });
    session = sendPendingToKitchen(addItemToSession(session, MENU[0], 1)).session;
    const renamed = setTableServer(session, "  Ravi   Kumar ");
    expect(renamed.serverName).toBe("Ravi Kumar");
    expect(renamed.tickets[0].serverName).toBe("Asha");
    expect(() => setTableServer(session, "R")).toThrow(/server name/);
    expect(() => setTableServer(paidTable(), "Ravi")).toThrow(/settled/);
  });
});

describe("owner corrections to a paid bill", () => {
  it("changes how a bill was paid, recording what changed and why", () => {
    const paid = paidTable("CASH");
    const total = calculatePosBill(paid).grandTotal;
    const corrected = changeSettledPayment(paid, "UPI", " Paid by GPay ", null);
    expect(corrected.status).toBe("SETTLED");
    expect(corrected.payment).toMatchObject({ method: "UPI", amountTendered: total, changeDue: 0 });
    expect(corrected.corrections).toEqual([
      expect.objectContaining({ kind: "payment", detail: "Paid by CASH → UPI", reason: "Paid by GPay" }),
    ]);
    expect(summarizeShift([corrected]).byPaymentMethod).toMatchObject({ CASH: 0, UPI: total });
    expect(() => changeSettledPayment(corrected, "UPI", "", null)).toThrow(/already marked as UPI/);
  });

  it("reopens a paid bill so more can be added, then settles it again", () => {
    const paid = paidTable("UPI");
    expect(() => reopenSettledSession(paid, "no", null, [paid])).toThrow(/why/);
    const reopened = reopenSettledSession(paid, "Guests ordered dessert", null, [paid]);
    expect(reopened).toMatchObject({ status: "OPEN", payment: null });
    expect(reopened.corrections[0]).toMatchObject({ kind: "reopen", reason: "Guests ordered dessert" });

    const more = sendPendingToKitchen(addItemToSession(reopened, MENU[1], 1)).session;
    const settledAgain = settleSession(more, "UPI", 0);
    expect(calculatePosBill(settledAgain).grandTotal).toBeGreaterThan(calculatePosBill(paid).grandTotal);
  });

  it("will not reopen onto a table that already has new guests", () => {
    const paid = paidTable();
    const newGuests = openTableSession({ ...OUTLET, tableId: "T1", guestCount: 4, serverName: "Ravi" });
    expect(() => reopenSettledSession(paid, "Ordered more", null, [paid, newGuests])).toThrow(
      /new guests/
    );
  });

  it("refuses to change an open bill or one whose shift has been closed", () => {
    const open = openTableSession({ ...OUTLET, tableId: "T2", guestCount: 1, serverName: "Asha" });
    expect(() => changeSettledPayment(open, "UPI", "", null)).toThrow(/Only a paid bill/);
    const inOldShift = paidTable("CASH", "SHIFT-old");
    expect(() => changeSettledPayment(inOldShift, "UPI", "", "SHIFT-new")).toThrow(/closed shift/);
    expect(() => changeSettledPayment(inOldShift, "UPI", "", null)).toThrow(/closed shift/);
    expect(changeSettledPayment(inOldShift, "UPI", "", "SHIFT-old").payment?.method).toBe("UPI");
  });

  it("keeps corrections through storage and drops malformed ones", () => {
    const corrected = changeSettledPayment(paidTable(), "CARD", "Swiped", null);
    const stored = JSON.stringify([
      { ...corrected, corrections: [...corrected.corrections, { kind: "refund", at: "x" }, "junk"] },
    ]);
    expect(restorePosSessions(stored)[0].corrections).toEqual(corrected.corrections);
  });
});

describe.skipIf(!hasTestDatabase)("owner PIN and corrected bills on the server", () => {
  beforeAll(startTestDatabase);
  afterAll(stopTestDatabase);
  beforeEach(resetTestDatabase);

  const PASSWORD = "135790";

  async function owner() {
    const user = await registerUser({ email: "owner@pin.test", password: PASSWORD });
    const outlet = await seedPosOutlet(user);
    const restaurant = await one<{ id: string }>(
      "SELECT id FROM managed_restaurants WHERE pos_outlet_id = $1",
      [outlet.outletId]
    );
    return { user, outlet, restaurantId: String(restaurant?.id) };
  }

  it("needs the account password to set the PIN, then accepts only that PIN", async () => {
    const { user, outlet, restaurantId } = await owner();
    await expect(confirmPosOwnerPin(user.id, { outletId: outlet.outletId, pin: "1234" })).rejects.toThrow(
      POS_PIN_MISSING
    );
    await expect(setPosOwnerPin(user.id, restaurantId, { pin: "12", password: PASSWORD }, "test")).rejects.toThrow(
      /4 to 6 digits/
    );
    await expect(
      setPosOwnerPin(user.id, restaurantId, { pin: "4321", password: "wrong-password" }, "test")
    ).rejects.toThrow(/current PIN is incorrect/);
    await setPosOwnerPin(user.id, restaurantId, { pin: "4321", password: PASSWORD }, "test");

    await expect(confirmPosOwnerPin(user.id, { outletId: outlet.outletId, pin: "1234" })).rejects.toThrow(
      /Wrong owner PIN/
    );
    await expect(confirmPosOwnerPin(user.id, { outletId: outlet.outletId, pin: "4321" })).resolves.toBeUndefined();
    const stored = await one<{ pos_pin_hash: string }>("SELECT pos_pin_hash FROM managed_restaurants");
    expect(stored?.pos_pin_hash).not.toContain("4321");
  });

  it("locks the PIN after repeated wrong guesses", async () => {
    const { user, outlet, restaurantId } = await owner();
    await setPosOwnerPin(user.id, restaurantId, { pin: "4321", password: PASSWORD }, "test");
    for (let i = 0; i < 5; i += 1) {
      await expect(confirmPosOwnerPin(user.id, { outletId: outlet.outletId, pin: "0000" })).rejects.toThrow(
        /Wrong owner PIN/
      );
    }
    await expect(confirmPosOwnerPin(user.id, { outletId: outlet.outletId, pin: "4321" })).rejects.toThrow(
      /Too many wrong PINs/
    );
  });

  it("refuses the PIN check for another restaurant's terminal", async () => {
    const { outlet } = await owner();
    const stranger = await registerUser({ email: "stranger@pin.test", password: PASSWORD });
    await expect(confirmPosOwnerPin(stranger.id, { outletId: outlet.outletId, pin: "4321" })).rejects.toThrow(
      /do not have access/
    );
  });

  it("updates a saved dine-in bill when the owner corrects how it was paid", async () => {
    const { user, outlet } = await owner();
    let session = openTableSession({
      outletId: outlet.outletId,
      outletName: outlet.name,
      taxRateBps: outlet.taxRateBps,
      tableId: "T1",
      guestCount: 1,
      serverName: "Asha",
    });
    session = sendPendingToKitchen(addItemToSession(session, outlet.menu[0], 1)).session;
    const total = calculatePosBill(session).grandTotal;
    const paid = settleSession(session, "CASH", total);
    const first = await syncPosState(user.id, { sessions: [paid] });
    const code = await getClaimCode(paid.sessionId);
    const guest = await registerUser({ email: "guest@pin.test", password: PASSWORD });
    await claimDineInBill(guest.id, { code });

    const stored = first.sessions[0];
    const corrected = changeSettledPayment(stored, "UPI", "GPay", null);
    const second = await syncPosState(user.id, { sessions: [corrected] });
    expect(second.rejected).toEqual([]);
    expect(second.sessions[0].corrections).toHaveLength(1);
    expect(await one("SELECT payment_method, claim_code FROM dine_in_bills")).toEqual({
      payment_method: "UPI",
      claim_code: code,
    });
  });
});
