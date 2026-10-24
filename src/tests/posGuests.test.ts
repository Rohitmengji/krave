import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerUser } from "@/lib/server/auth";
import { run } from "@/lib/server/pg";
import { listPosOutlets } from "@/lib/server/posCatalog";
import { loadPosState, syncPosState } from "@/lib/server/posStore";
import { billSmsText, smsHref, smsSegments } from "@/lib/pos/billSms";
import {
  addItemToSession,
  calculateItemizedSplit,
  calculatePosBill,
  mergeTableSessions,
  normalizeIndianMobile,
  openTableSession,
  restorePosSessions,
  sendPendingToKitchen,
  setTableGuest,
  settleSession,
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

function table(guestCount = 2, extra: Partial<Parameters<typeof openTableSession>[0]> = {}) {
  return openTableSession({ ...OUTLET, tableId: "T1", guestCount, serverName: "Asha", ...extra });
}

describe("guest mobile numbers", () => {
  it("accepts the ways people say an Indian mobile number and stores one form", () => {
    for (const raw of ["9876543210", "98765 43210", "+91 98765-43210", "919876543210", "09876543210", " (98765) 43210 "]) {
      expect(normalizeIndianMobile(raw), raw).toBe("+919876543210");
    }
  });

  it("refuses numbers that cannot be Indian mobiles", () => {
    for (const raw of ["", "5876543210", "987654321", "98765432101", "+1 9876543210", "022-2345 6789", "98765abcde"]) {
      expect(normalizeIndianMobile(raw), raw).toBeNull();
    }
  });
});

describe("guests at a table", () => {
  it("takes the lead guest when the table opens, and opens nothing on a bad number", () => {
    const opened = table(2, { leadGuest: { name: "  Ramesh   Patil ", phone: "98765 43210" } });
    expect(opened.guests).toEqual([{ seat: 1, name: "Ramesh Patil", phone: "+919876543210" }]);
    expect(table(2, { leadGuest: { name: "", phone: "" } }).guests).toEqual([]);
    expect(() => table(2, { leadGuest: { name: "Ramesh", phone: "12345" } })).toThrow(/10-digit/);
  });

  it("records each seat, refuses a seat that is not at the table, and forgets a cleared one", () => {
    let session = table(2);
    session = setTableGuest(session, 2, { name: "Sunita", phone: "" });
    session = setTableGuest(session, 1, { name: "", phone: "9123456789" });
    expect(session.guests).toEqual([
      { seat: 1, name: "", phone: "+919123456789" },
      { seat: 2, name: "Sunita", phone: null },
    ]);
    expect(() => setTableGuest(session, 3, { name: "Extra", phone: "" })).toThrow(/between 1 and 2/);
    expect(() => setTableGuest(session, 1, { name: "x".repeat(41), phone: "" })).toThrow(/under 40/);
    expect(setTableGuest(session, 2, { name: " ", phone: "" }).guests.map((guest) => guest.seat)).toEqual([1]);
  });

  it("names each share after its guest, and the shares still add up to the bill", () => {
    let session = table(2);
    session = addItemToSession(session, MENU[0], 1);
    session = addItemToSession(session, MENU[1], 1);
    session = setTableGuest(session, 1, { name: "Ramesh", phone: "9876543210" });
    const shares = calculateItemizedSplit(session, { [session.lines[0].lineId]: 1 });
    expect(shares.map((share) => share.guestLabel)).toEqual(["Ramesh", "Guest 2"]);
    expect(shares.reduce((sum, share) => sum + share.payableAmount, 0)).toBe(calculatePosBill(session).grandTotal);
  });

  it("still takes a number after the bill is paid, so the receipt can be texted", () => {
    let session = addItemToSession(table(1), MENU[0], 1);
    session = sendPendingToKitchen(session).session;
    session = settleSession(session, "UPI", 0);
    expect(setTableGuest(session, 1, { name: "Late", phone: "9876543210" }).guests).toHaveLength(1);
  });

  it("seats a merged party after the destination's own guests", () => {
    let target = setTableGuest(table(2), 1, { name: "Host", phone: "9876543210" });
    target = addItemToSession(target, MENU[0], 1);
    let source = openTableSession({ ...OUTLET, tableId: "T2", guestCount: 2, serverName: "Asha" });
    source = setTableGuest(addItemToSession(source, MENU[1], 1), 2, { name: "Visitor", phone: "9123456789" });

    const merged = mergeTableSessions([target, source], source.sessionId, target.sessionId);
    const into = merged.find((session) => session.sessionId === target.sessionId) as PosTableSession;
    const from = merged.find((session) => session.sessionId === source.sessionId) as PosTableSession;
    expect(into.guestCount).toBe(4);
    expect(into.guests.map((guest) => [guest.seat, guest.name])).toEqual([
      [1, "Host"],
      [4, "Visitor"],
    ]);
    expect(from.guests).toEqual([]);
  });

  it("restores guests from storage one by one, dropping only the bad entries", () => {
    const stored = JSON.stringify([
      {
        ...table(3),
        guests: [
          { seat: 1, name: "Ramesh", phone: "9876543210" },
          { seat: 1, name: "Duplicate", phone: null },
          { seat: 2, name: "", phone: "12345" },
          { seat: 99, name: "Too far", phone: null },
          { seat: 3, name: "<b>Asha</b>", phone: "+91 91234 56789" },
          "nonsense",
        ],
      },
    ]);
    expect(restorePosSessions(stored)[0].guests).toEqual([
      { seat: 1, name: "Ramesh", phone: "+919876543210" },
      { seat: 3, name: "<b>Asha</b>", phone: "+919123456789" },
    ]);
  });
});

describe("tax on a table bill", () => {
  it("bills the menu price when the restaurant charges no tax", () => {
    const session = addItemToSession(table(2, { taxRateBps: 0 }), MENU[0], 2);
    const bill = calculatePosBill(session);
    expect(bill.taxTotal).toBe(0);
    expect(bill.grandTotal).toBe(MENU[0].price * 2);
  });

  it("splits the restaurant's rate into CGST and SGST halves", () => {
    const item = { ...MENU[0], price: 250 };
    const five = calculatePosBill(addItemToSession(table(1, { taxRateBps: 500 }), item, 1));
    expect(five).toMatchObject({ cgstRateBps: 250, sgstRateBps: 250, cgst: 6.25, sgst: 6.25, grandTotal: 263 });
    const eighteen = calculatePosBill(addItemToSession(table(1, { taxRateBps: 1800 }), item, 1));
    expect(eighteen).toMatchObject({ cgstRateBps: 900, sgstRateBps: 900, grandTotal: 295 });
  });

  it("refuses an unusable rate, and keeps 5% for tables saved before rates were per restaurant", () => {
    for (const taxRateBps of [-1, 10001, 2.5, Number.NaN]) {
      expect(() => table(1, { taxRateBps }), String(taxRateBps)).toThrow(/tax rate/);
    }
    const legacy: Record<string, unknown> = { ...table(1, { taxRateBps: 0 }) };
    delete legacy.taxRateBps;
    delete legacy.guests;
    const [restored] = restorePosSessions(JSON.stringify([legacy]));
    expect(restored.taxRateBps).toBe(500);
    expect(restored.guests).toEqual([]);
  });
});

describe("bill text messages", () => {
  const base = {
    outletName: "Jagadamba Maratha Khanawali",
    tableId: "T3",
    guestName: "Ramesh",
    total: 263,
    guestCount: 2,
    paid: false,
  };

  it("tells each guest the table total and their own share, in a single SMS", () => {
    const text = billSmsText({ ...base, share: 132 });
    expect(text).toBe(
      "Jagadamba Maratha Khanawali: Hi Ramesh, the bill for table T3 is Rs.263 for 2 guests. Your share is Rs.132. Thank you!"
    );
    expect(smsSegments(text)).toBe(1);
  });

  it("tells one payer the whole bill, and thanks them once it is paid", () => {
    expect(billSmsText({ ...base, share: null, guestName: "" })).toBe(
      "Jagadamba Maratha Khanawali: Hello, your bill for table T3 is Rs.263. Thank you!"
    );
    expect(billSmsText({ ...base, share: 263, guestCount: 1, paid: true })).toBe(
      "Jagadamba Maratha Khanawali: Hi Ramesh, your bill for table T3 is Rs.263. Paid, thank you for visiting!"
    );
  });

  it("builds a link the phone's messaging app opens with the text filled in", () => {
    expect(smsHref("+919876543210", "Rs.263 & thanks")).toBe("sms:+919876543210?&body=Rs.263%20%26%20thanks");
  });

  it("counts what a text costs from the daily allowance", () => {
    expect(smsSegments("a".repeat(160))).toBe(1);
    expect(smsSegments("a".repeat(161))).toBe(2);
    expect(smsSegments("{".repeat(80))).toBe(1);
    expect(smsSegments("{".repeat(81))).toBe(2);
    // A rupee sign or a name in Devanagari makes it Unicode: 70 characters per SMS.
    expect(smsSegments("₹".repeat(70))).toBe(1);
    expect(smsSegments(`रमेश ${"a".repeat(70)}`)).toBe(2);
  });
});

describe.skipIf(!hasTestDatabase)("guests and tax through terminal sync", () => {
  beforeAll(startTestDatabase);
  afterAll(stopTestDatabase);
  beforeEach(resetTestDatabase);

  async function ownerWithOutlet() {
    const owner = await registerUser({ email: "owner@guests.test", password: "correct-horse-battery" });
    const outlet = await seedPosOutlet(owner);
    return { owner, outlet };
  }

  function seat(outlet: Awaited<ReturnType<typeof seedPosOutlet>>, taxRateBps: number) {
    const opened = openTableSession({
      outletId: outlet.outletId,
      outletName: outlet.name,
      taxRateBps,
      tableId: "T1",
      guestCount: 2,
      serverName: "Asha",
      leadGuest: { name: "Ramesh", phone: "98765 43210" },
    });
    return addItemToSession(opened, outlet.menu[0], 1);
  }

  it("keeps the table's guests on the account", async () => {
    const { owner, outlet } = await ownerWithOutlet();
    const session = setTableGuest(seat(outlet, outlet.taxRateBps), 2, { name: "Sunita", phone: "9123456789" });
    const result = await syncPosState(owner.id, { sessions: [session] });
    expect(result.rejected).toEqual([]);

    const [stored] = (await loadPosState(owner.id)).sessions;
    expect(stored.guests).toEqual([
      { seat: 1, name: "Ramesh", phone: "+919876543210" },
      { seat: 2, name: "Sunita", phone: "+919123456789" },
    ]);
  });

  it("bills a new table at the restaurant's own rate, whatever the device sent", async () => {
    const { owner, outlet } = await ownerWithOutlet();
    // The seeded restaurant charges no tax, like the online menu.
    expect(outlet.taxRateBps).toBe(0);
    await syncPosState(owner.id, { sessions: [seat(outlet, 1800)] });
    const [stored] = (await loadPosState(owner.id)).sessions;
    expect(stored.taxRateBps).toBe(0);
    expect(calculatePosBill(stored).grandTotal).toBe(outlet.menu[0].price);
  });

  it("keeps an open table's rate when the owner changes the setting mid-meal", async () => {
    const { owner, outlet } = await ownerWithOutlet();
    const session = seat(outlet, 0);
    await syncPosState(owner.id, { sessions: [session] });

    await run("UPDATE managed_restaurants SET tax_enabled = 1, tax_rate_bps = 500");
    const [reloaded] = await listPosOutlets(owner.id);
    expect(reloaded.taxRateBps).toBe(500);

    const [before] = (await loadPosState(owner.id)).sessions;
    await syncPosState(owner.id, { sessions: [{ ...before, serviceChargePercent: 0 }] });
    const [after] = (await loadPosState(owner.id)).sessions;
    expect(after.taxRateBps).toBe(0);

    const fresh = { ...seat(reloaded, 0), tableId: "T2" };
    await syncPosState(owner.id, { sessions: [fresh] });
    const stored = (await loadPosState(owner.id)).sessions.find((candidate) => candidate.tableId === "T2");
    expect(stored?.taxRateBps).toBe(500);
  });
});
