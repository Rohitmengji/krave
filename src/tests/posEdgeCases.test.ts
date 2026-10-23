import { describe, expect, it } from "vitest";
import {
  addCustomItemToSession,
  addItemToSession,
  calculateItemizedSplit,
  calculatePosBill,
  closeShift,
  openShift,
  openTableSession,
  POS_MAX_STORED_SESSIONS,
  releaseTable,
  restorePosSessions,
  sendPendingToKitchen,
  setLineNote,
  setSessionCharges,
  settleSession,
  voidLine,
  type PosMenuItem,
  type PosTableSession,
} from "@/lib/pos/posEngine";
import { MENU, OUTLET, SECOND_OUTLET } from "./support/posFixture";

const DISH = MENU[0];

function seat(tableId = "T1", guestCount = 2, outlet = OUTLET, shiftId: string | null = null) {
  return openTableSession({ ...outlet, tableId, guestCount, serverName: "Asha", shiftId });
}

function priced(price: number): PosMenuItem {
  return { ...DISH, itemId: `dish-${price}`, price };
}

/** A tiny deterministic generator so the property checks are reproducible. */
function lcg(seed: number) {
  let state = seed;
  return (max: number) => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state % max;
  };
}

describe("POS-6 · cooking notes typed into a controlled input", () => {
  it("keeps the spaces between words while typing and trims only when the ticket fires", () => {
    let session = addItemToSession(seat(), DISH, 1);
    const lineId = session.lines[0].lineId;
    // Feed each keystroke back through the engine, as the controlled input does.
    for (const char of "  no onion, less oil  ") {
      session = setLineNote(session, lineId, session.lines[0].note + char);
    }
    expect(session.lines[0].note).toBe("  no onion, less oil  ");

    const { session: fired, ticket } = sendPendingToKitchen(session);
    expect(ticket.lines[0].note).toBe("no onion, less oil");
    expect(fired.lines[0].note).toBe("no onion, less oil");
  });

  it("still merges a repeat tap into an un-fired line whose note has stray spaces", () => {
    let session = addItemToSession(seat(), DISH, 1, "Jain");
    session = setLineNote(session, session.lines[0].lineId, "Jain ");
    session = addItemToSession(session, DISH, 1, "Jain");
    expect(session.lines).toHaveLength(1);
    expect(session.lines[0].quantity).toBe(2);
  });
});

describe("POS-9 · seating a table that became occupied", () => {
  it("refuses a second open bill on the same table at the same outlet", () => {
    const floor = [seat("T1")];
    expect(() => openTableSession({ ...OUTLET, tableId: "T1", guestCount: 2, serverName: "Ravi" }, floor)).toThrow(
      "Table T1 is already occupied."
    );
  });

  it("allows it when the earlier bill is closed or belongs to another outlet", () => {
    const settled = settleSession(sendPendingToKitchen(addItemToSession(seat("T1"), DISH, 1)).session, "UPI", 0);
    const released = releaseTable(seat("T1"));
    const elsewhere = seat("T1", 2, SECOND_OUTLET);
    const floor = [settled, released, elsewhere];
    expect(openTableSession({ ...OUTLET, tableId: "T1", guestCount: 2, serverName: "Ravi" }, floor).status).toBe(
      "OPEN"
    );
  });
});

describe("POS-10 · releasing empty tables and partial voids", () => {
  it("releases an empty table, keeps it for audit and frees the floor", () => {
    const released = releaseTable(seat("T3"));
    expect(released.status).toBe("RELEASED");
    expect(() => addItemToSession(released, DISH, 1)).toThrow("released without a bill");
    expect(() => releaseTable(released)).toThrow();
    expect(restorePosSessions(JSON.stringify([released]))[0].status).toBe("RELEASED");
  });

  it("refuses to release a table that still has items on it", () => {
    expect(() => releaseTable(addItemToSession(seat(), DISH, 1))).toThrow(
      "Void or settle the items on this table before releasing it."
    );
  });

  it("voids part of a fired line and keeps the rest on its original KOT", () => {
    const fired = sendPendingToKitchen(addItemToSession(seat(), priced(60), 3)).session;
    const lineId = fired.lines[0].lineId;

    const partial = voidLine(fired, lineId, "Guest only wanted two", 1);
    expect(partial.lines[0].quantity).toBe(2);
    expect(partial.lines[0].kotNumber).toBe(1);
    expect(partial.voids).toEqual([expect.objectContaining({ quantity: 1, reason: "Guest only wanted two" })]);
    expect(calculatePosBill(partial).subtotal).toBe(120);

    for (const quantity of [0, 4, 1.5, Number.NaN]) {
      expect(() => voidLine(fired, lineId, "Guest changed order", quantity)).toThrow();
    }
    expect(voidLine(fired, lineId, "Guest changed order").lines).toHaveLength(0);
  });

  it("counts the voids of a fully voided, released table in the shift report", () => {
    const shift = openShift({ ...OUTLET, openedBy: "Meera", openingCash: 1000 });
    const fired = sendPendingToKitchen(addItemToSession(seat("T2", 2, OUTLET, shift.shiftId), DISH, 2)).session;
    const released = releaseTable(voidLine(fired, fired.lines[0].lineId, "Guest walked out"));

    const { report } = closeShift(shift, [released], { closedBy: "Meera", countedCash: 1000 });
    expect(report.voidCount).toBe(1);
    expect(report.openTablesAtClose).toBe(0);
    expect(report.summary.settledBills).toBe(0);
  });
});

describe("POS-11 · custom dishes with non-Latin names", () => {
  it("keeps two different dishes at the same price on separate lines and KOT rows", () => {
    let session = addCustomItemToSession(seat(), { name: "मसाला चाय", price: 40 });
    session = addCustomItemToSession(session, { name: "अदरक चाय", price: 40 });
    expect(session.lines.map((line) => line.name)).toEqual(["मसाला चाय", "अदरक चाय"]);
    expect(new Set(session.lines.map((line) => line.itemId)).size).toBe(2);
    // The sync reprices anything without this prefix from the catalog.
    expect(session.lines.every((line) => line.itemId.startsWith("custom_"))).toBe(true);
    expect(sendPendingToKitchen(session).ticket.lines).toHaveLength(2);
  });
});

describe("POS-12 · guest shares add up to the printed bill", () => {
  it("splits ₹100 shared by two to exactly ₹105, not 53 + 53", () => {
    const session = addItemToSession(seat("T1", 2), priced(100), 1);
    const split = calculateItemizedSplit(session);
    expect(calculatePosBill(session).grandTotal).toBe(105);
    expect(split.map((share) => share.payableAmount)).toEqual([53, 52]);
  });

  it("splits ₹110 three ways to exactly ₹116 and items to exactly ₹110", () => {
    const session = addItemToSession(seat("T1", 3), priced(110), 1);
    const split = calculateItemizedSplit(session);
    expect(split.map((share) => share.payableAmount)).toEqual([39, 39, 38]);
    expect(split.map((share) => share.itemsSubtotal)).toEqual([36.67, 36.67, 36.66]);
  });

  it("always adds up across random bills, assignments, discounts and service charges", () => {
    const rand = lcg(7);
    for (let round = 0; round < 300; round += 1) {
      const guests = 1 + rand(8);
      let session = seat("T1", guests);
      const lineCount = 1 + rand(6);
      for (let i = 0; i < lineCount; i += 1) {
        session = addItemToSession(session, priced(1 + rand(900)), 1 + rand(4));
      }
      session = setSessionCharges(session, {
        discountPercent: rand(4) === 0 ? rand(101) : 0,
        serviceChargePercent: rand(21),
      });
      const assignments = Object.fromEntries(session.lines.map((line) => [line.lineId, rand(guests + 2)]));

      const bill = calculatePosBill(session);
      const split = calculateItemizedSplit(session, assignments);
      const payable = split.reduce((sum, share) => sum + share.payableAmount, 0);
      const itemsPaise = split.reduce((sum, share) => sum + Math.round(share.itemsSubtotal * 100), 0);
      expect(payable).toBe(bill.grandTotal);
      expect(itemsPaise).toBe(Math.round(bill.subtotal * 100));
      for (const share of split) expect(Number.isSafeInteger(share.payableAmount)).toBe(true);
    }
  });
});

describe("STK-5 / POS-17 · money in integer paise, no silent rounding of inputs", () => {
  it("rounds an exact half paisa up (2.5% of ₹41.40 is ₹1.035 → ₹1.04)", () => {
    // ₹46 less 10% leaves a taxable ₹41.40; float rupees rounded this CGST down to ₹1.03.
    const session = setSessionCharges(addItemToSession(seat(), priced(46), 1), { discountPercent: 10 });
    const bill = calculatePosBill(session);
    expect(bill.discountAmount).toBe(4.6);
    expect(bill.cgst).toBe(1.04);
    expect(bill.sgst).toBe(1.04);
    expect(bill.taxTotal).toBe(2.08);
  });

  it("keeps every bill line a whole number of paise that reconciles to the total", () => {
    const rand = lcg(11);
    for (let round = 0; round < 500; round += 1) {
      let session = addItemToSession(seat(), priced(1 + rand(5000)), 1 + rand(9));
      session = setSessionCharges(session, { discountPercent: rand(101), serviceChargePercent: rand(21) });
      const bill = calculatePosBill(session);
      const paise = [bill.subtotal, bill.discountAmount, bill.serviceCharge, bill.cgst, bill.sgst, bill.roundOff].map(
        (amount) => amount * 100
      );
      for (const value of paise) expect(Math.abs(value - Math.round(value))).toBeLessThan(1e-6);
      const [subtotal, discount, service, cgst, sgst, roundOff] = paise.map(Math.round);
      expect(subtotal - discount + service + cgst + sgst + roundOff).toBe(bill.grandTotal * 100);
      expect(Math.abs(roundOff)).toBeLessThanOrEqual(50);
    }
  });

  it("refuses fractional percents instead of rounding 12.5% to 13%", () => {
    const session = seat();
    expect(() => setSessionCharges(session, { discountPercent: 12.5 })).toThrow(
      "Discount must be a whole percent between 0 and 100."
    );
    expect(() => setSessionCharges(session, { serviceChargePercent: 2.5 })).toThrow("whole percent");
    expect(setSessionCharges(session, { discountPercent: 12 }).discountPercent).toBe(12);
  });

  it("refuses fractional cash instead of recording a different amount", () => {
    const fired = sendPendingToKitchen(addItemToSession(seat(), priced(1000), 1)).session;
    expect(() => settleSession(fired, "CASH", 1100.5)).toThrow("whole rupee amount of at least ₹1050");
    expect(settleSession(fired, "CASH", 1100).payment?.changeDue).toBe(50);

    expect(() => openShift({ ...OUTLET, openedBy: "Meera", openingCash: 2000.5 })).toThrow("whole rupee");
    const shift = openShift({ ...OUTLET, openedBy: "Meera", openingCash: 2000 });
    expect(() => closeShift(shift, [], { closedBy: "Meera", countedCash: 10.4 })).toThrow("whole rupee");
    expect(() => addCustomItemToSession(seat(), { name: "Masala Soda", price: 99.5 })).toThrow("whole rupee");
  });
});

describe("POS-2 (engine half) · restoring a long-lived terminal", () => {
  function settledAt(base: PosTableSession, index: number): PosTableSession {
    const stamp = new Date(Date.UTC(2026, 0, 1) + index * 60000).toISOString();
    return {
      ...base,
      sessionId: `POS-settled-${index}`,
      openedAt: stamp,
      payment: { method: "UPI", amountTendered: 105, changeDue: 0, settledAt: stamp },
    };
  }

  it("keeps every open table and the newest bills instead of the oldest 200", () => {
    const template = settleSession(sendPendingToKitchen(addItemToSession(seat("T2"), priced(100), 1)).session, "UPI", 0);
    const history = Array.from({ length: 260 }, (_, index) => settledAt(template, index));
    const openEarly = { ...seat("T1"), openedAt: new Date(Date.UTC(2025, 11, 31)).toISOString() };
    const stored = [openEarly, ...history];

    const restored = restorePosSessions(JSON.stringify(stored));
    expect(restored).toHaveLength(POS_MAX_STORED_SESSIONS);
    expect(restored[0].sessionId).toBe(openEarly.sessionId);
    expect(restored.at(-1)?.sessionId).toBe("POS-settled-259");
    expect(restored.some((session) => session.sessionId === "POS-settled-0")).toBe(false);
    // Original order is preserved.
    const indexes = restored.slice(1).map((session) => Number(session.sessionId.split("-").at(-1)));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("never drops an open table, even past the cap", () => {
    const open = Array.from({ length: POS_MAX_STORED_SESSIONS + 5 }, () => seat("T1"));
    expect(restorePosSessions(JSON.stringify(open))).toHaveLength(POS_MAX_STORED_SESSIONS + 5);
  });
});
