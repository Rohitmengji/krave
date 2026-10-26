import { describe, expect, it } from "vitest";
import {
  addCustomItemToSession,
  addItemToSession,
  calculateItemizedSplit,
  calculatePosBill,
  closeShift,
  findKitchenTicket,
  foldDuplicateTable,
  getShiftSessions,
  mergeTableSessions,
  openShift,
  openTableSession,
  POS_TABLES,
  restorePosSessions,
  restorePosShift,
  sendPendingToKitchen,
  setLineNote,
  setLineQuantity,
  setSessionCharges,
  setTableGuest,
  settleSession,
  summarizeShift,
  transferTableSession,
  voidLine,
} from "@/lib/pos/posEngine";
import { MENU, OUTLET, SECOND_OUTLET } from "./support/posFixture";

function freshSession(tableId: string = POS_TABLES[0].tableId) {
  return openTableSession({
    ...OUTLET,
    tableId,
    guestCount: 2,
    serverName: "Asha",
  });
}

describe("Dine-in POS billing engine", () => {
  it("opens a table only with a valid outlet, table, guest count and server", () => {
    const session = freshSession();
    expect(session.status).toBe("OPEN");
    expect(session.lines).toHaveLength(0);

    expect(() =>
      openTableSession({ ...OUTLET, outletId: -1, tableId: "T1", guestCount: 2, serverName: "Asha" })
    ).toThrow();
    expect(() =>
      openTableSession({ ...OUTLET, outletName: " ", tableId: "T1", guestCount: 2, serverName: "Asha" })
    ).toThrow(/valid outlet/);
    expect(() =>
      openTableSession({ ...OUTLET, tableId: "ZZ", guestCount: 2, serverName: "Asha" })
    ).toThrow();
    expect(() =>
      openTableSession({ ...OUTLET, tableId: "T1", guestCount: 0, serverName: "Asha" })
    ).toThrow();
    expect(() =>
      openTableSession({ ...OUTLET, tableId: "T1", guestCount: 2, serverName: " " })
    ).toThrow();
  });

  it("merges repeat taps before the ticket is fired and keeps new lines after", () => {
    let session = addItemToSession(freshSession(), MENU[0], 1);
    session = addItemToSession(session, MENU[0], 2);
    expect(session.lines).toHaveLength(1);
    expect(session.lines[0].quantity).toBe(3);

    session = sendPendingToKitchen(session).session;
    session = addItemToSession(session, MENU[0], 1);
    expect(session.lines).toHaveLength(2);
    expect(session.lines[0].kotNumber).toBe(1);
    expect(session.lines[1].kotNumber).toBeNull();
  });

  it("rejects invalid quantities and blocks silent reductions after the kitchen is notified", () => {
    const base = addItemToSession(freshSession(), MENU[0], 2);
    for (const quantity of [-1, 1.5, NaN, Infinity, 100]) {
      expect(() => addItemToSession(freshSession(), MENU[0], quantity)).toThrow();
    }

    // Removing a line is allowed while it is still pending.
    expect(setLineQuantity(base, base.lines[0].lineId, 0).lines).toHaveLength(0);

    const fired = sendPendingToKitchen(base).session;
    expect(() => setLineQuantity(fired, fired.lines[0].lineId, 1)).toThrow();
    expect(setLineQuantity(fired, fired.lines[0].lineId, 5).lines[0].quantity).toBe(5);
  });

  it("requires a reason to void a fired item and records it on the bill", () => {
    const fired = sendPendingToKitchen(
      addItemToSession(freshSession(), MENU[0], 1)
    ).session;

    expect(() => voidLine(fired, fired.lines[0].lineId, "x")).toThrow();

    const voided = voidLine(fired, fired.lines[0].lineId, "Guest changed order");
    expect(voided.lines).toHaveLength(0);
    expect(voided.voids[0].reason).toBe("Guest changed order");
    expect(calculatePosBill(voided).grandTotal).toBe(0);
  });

  it("applies discount before tax, adds GST halves and rounds the payable total", () => {
    const item = { ...MENU[0], price: 1000 };
    let session = addItemToSession(freshSession(), item, 2);
    session = setSessionCharges(session, { discountPercent: 10, serviceChargePercent: 5 });

    const bill = calculatePosBill(session);
    expect(bill.subtotal).toBe(2000);
    expect(bill.discountAmount).toBe(200);
    expect(bill.serviceCharge).toBe(90); // 5% of 1800
    expect(bill.cgst).toBe(47.25); // 2.5% of 1890
    expect(bill.sgst).toBe(47.25);
    expect(bill.grandTotal).toBe(1985); // 1984.50 rounded
    expect(bill.roundOff).toBe(0.5);
    expect(bill.perGuest).toBe(993); // 1985 split across 2 guests, rounded up
  });

  it("rejects out-of-range discounts, service charges and guest counts", () => {
    const session = freshSession();
    expect(() => setSessionCharges(session, { discountPercent: 101 })).toThrow();
    expect(() => setSessionCharges(session, { discountPercent: -1 })).toThrow();
    expect(() => setSessionCharges(session, { serviceChargePercent: 21 })).toThrow();
    expect(() => setSessionCharges(session, { guestCount: 0 })).toThrow();
  });

  it("fires one numbered kitchen ticket per round of pending items", () => {
    const session = addItemToSession(freshSession(), MENU[0], 2);
    const first = sendPendingToKitchen(session);
    expect(first.ticket.kotNumber).toBe(1);
    expect(first.ticket.lines).toEqual([
      { name: MENU[0].name, quantity: 2, note: "", dietary: MENU[0].dietary },
    ]);

    expect(() => sendPendingToKitchen(first.session)).toThrow();

    const second = sendPendingToKitchen(addItemToSession(first.session, MENU[1], 1));
    expect(second.ticket.kotNumber).toBe(2);
    expect(second.ticket.lines).toHaveLength(1);
  });

  it("settles only fired bills and returns the correct change", () => {
    const empty = freshSession();
    expect(() => settleSession(empty, "CASH", 500)).toThrow();

    const pending = addItemToSession(empty, MENU[0], 1);
    expect(() => settleSession(pending, "CASH", 5000)).toThrow();

    const fired = sendPendingToKitchen(pending).session;
    const total = calculatePosBill(fired).grandTotal;

    expect(() => settleSession(fired, "CASH", total - 1)).toThrow();

    const settled = settleSession(fired, "CASH", total + 100);
    expect(settled.status).toBe("SETTLED");
    expect(settled.payment?.changeDue).toBe(100);
    expect(() => settleSession(settled, "CASH", total)).toThrow();

    // Card and UPI are charged exactly, so no change is ever due.
    expect(settleSession(fired, "UPI", 0).payment?.changeDue).toBe(0);
  });

  it("summarizes settled bills for the shift", () => {
    const fired = sendPendingToKitchen(
      addItemToSession(freshSession(), { ...MENU[0], price: 1000 }, 1)
    ).session;
    const settled = settleSession(fired, "CARD", 0);

    const summary = summarizeShift([settled, fired]);
    expect(summary.settledBills).toBe(1);
    expect(summary.covers).toBe(2);
    expect(summary.grossSales).toBe(1050);
    expect(summary.byPaymentMethod.CARD).toBe(1050);
    expect(summary.averageBill).toBe(1050);
  });

  it("restores saved tables and discards corrupted records", () => {
    const fired = sendPendingToKitchen(
      addItemToSession(freshSession(), MENU[0], 2)
    ).session;

    const restored = restorePosSessions(JSON.stringify([fired]));
    expect(restored).toHaveLength(1);
    expect(calculatePosBill(restored[0]).grandTotal).toBe(calculatePosBill(fired).grandTotal);

    expect(restorePosSessions("not-json")).toEqual([]);
    expect(restorePosSessions("{}")).toEqual([]);
    expect(restorePosSessions(JSON.stringify([{ sessionId: "nope" }]))).toEqual([]);
    expect(restorePosSessions(JSON.stringify([{ ...fired, tableId: "ZZ" }]))).toEqual([]);
    expect(restorePosSessions(JSON.stringify([{ ...fired, status: "SETTLED" }]))).toEqual([]);

    const withBadLine = restorePosSessions(
      JSON.stringify([{ ...fired, lines: [...fired.lines, { lineId: "broken" }] }])
    );
    expect(withBadLine[0].lines).toHaveLength(1);
  });

  it("supports custom off-menu dishes, cooking notes, table transfers, and itemized guest bill splitting", () => {
    let session = freshSession();
    session = addCustomItemToSession(session, {
      name: "Chef Special Masala Soda",
      price: 180,
      dietary: "veg",
      quantity: 2,
      note: "Less ice",
    });
    expect(session.lines).toHaveLength(1);
    expect(session.lines[0].unitPrice).toBe(180);
    expect(session.lines[0].note).toBe("Less ice");

    session = setLineNote(session, session.lines[0].lineId, "Extra mint, no sugar");
    expect(session.lines[0].note).toBe("Extra mint, no sugar");

    session = addCustomItemToSession(session, {
      name: "Tandoori Platter",
      price: 640,
      dietary: "non-veg",
      quantity: 1,
    });

    const split = calculateItemizedSplit(session, {
      [session.lines[0].lineId]: 1, // Guest 1 takes 2x180 = 360
      [session.lines[1].lineId]: 2, // Guest 2 takes 640
    });
    expect(split).toHaveLength(2);
    expect(split[0].itemsSubtotal).toBe(360);
    expect(split[1].itemsSubtotal).toBe(640);
    expect(split[0].payableAmount + split[1].payableAmount).toBe(
      calculatePosBill(session).grandTotal
    );

    const transferred = transferTableSession([session], session.sessionId, "G1");
    expect(transferred[0].tableId).toBe("G1");
  });

  it("reprints the ticket the kitchen received, not the table's current state", () => {
    const fired = sendPendingToKitchen(
      addItemToSession(freshSession(), MENU[0], 2)
    ).session;

    const voided = voidLine(fired, fired.lines[0].lineId, "Guest changed order");
    const reprint = findKitchenTicket(voided, 1);
    expect(voided.lines).toHaveLength(0);
    expect(reprint.lines).toEqual([
      { name: MENU[0].name, quantity: 2, note: "", dietary: MENU[0].dietary },
    ]);
    expect(() => findKitchenTicket(voided, 9)).toThrow();

    const restored = restorePosSessions(JSON.stringify([voided]));
    expect(findKitchenTicket(restored[0], 1).lines).toHaveLength(1);
  });

  it("merges an open table into another and leaves the source unsettleable", () => {
    const target = sendPendingToKitchen(
      addItemToSession(freshSession("T1"), { ...MENU[0], price: 500 }, 1)
    ).session;
    const sourceFired = sendPendingToKitchen(
      addItemToSession(freshSession("T2"), { ...MENU[1], price: 300 }, 1)
    ).session;
    const source = addItemToSession(sourceFired, { ...MENU[2], price: 100 }, 1);

    const merged = mergeTableSessions([target, source], source.sessionId, target.sessionId);
    const mergedTarget = merged.find((s) => s.sessionId === target.sessionId)!;
    const mergedSource = merged.find((s) => s.sessionId === source.sessionId)!;

    expect(calculatePosBill(mergedTarget).subtotal).toBe(900);
    expect(mergedTarget.guestCount).toBe(4);
    expect(mergedSource.status).toBe("MERGED");
    expect(mergedSource.mergedIntoSessionId).toBe(target.sessionId);
    expect(mergedSource.lines).toHaveLength(0);

    // The moved ticket is renumbered into the destination sequence but keeps its origin.
    expect(mergedTarget.tickets.map((ticket) => ticket.kotNumber)).toEqual([1, 2]);
    expect(mergedTarget.tickets[1].mergedFrom).toBe("T2 · KOT 1");
    expect(mergedTarget.nextKotNumber).toBe(3);
    expect(mergedTarget.lines.filter((line) => line.kotNumber === null)).toHaveLength(1);

    expect(() => addItemToSession(mergedSource, MENU[0], 1)).toThrow();
    expect(() => settleSession(mergedSource, "CASH", 10000)).toThrow();
    expect(summarizeShift(merged).settledBills).toBe(0);
  });

  it("folds a table seated on a second phone into the bill already open there, as one party", () => {
    const open = sendPendingToKitchen(addItemToSession(freshSession("T3"), MENU[0], 1)).session;
    const duplicate = setTableGuest(
      sendPendingToKitchen(addItemToSession(freshSession("T3"), MENU[1], 2)).session,
      1,
      { name: "Ramesh", phone: "98765 43210" }
    );

    const folded = foldDuplicateTable([open, duplicate], duplicate.sessionId, open.sessionId);
    expect(folded).toHaveLength(1);
    const [bill] = folded;
    expect(bill.sessionId).toBe(open.sessionId);
    expect(bill.lines.map((line) => [line.name, line.quantity])).toEqual([
      [MENU[0].name, 1],
      [MENU[1].name, 2],
    ]);
    // Same two guests, not four; the second phone's guest details fill the empty seat.
    expect(bill.guestCount).toBe(2);
    expect(bill.guests).toEqual([{ seat: 1, name: "Ramesh", phone: "+919876543210" }]);
    // The second phone's kitchen ticket keeps its history under the open bill's numbering.
    expect(bill.tickets.map((ticket) => ticket.kotNumber)).toEqual([1, 2]);
    expect(bill.tickets[1].mergedFrom).toBe("T3 · KOT 1");

    // An empty duplicate simply goes; the open bill object is untouched.
    const empty = freshSession("T3");
    const [kept] = foldDuplicateTable([open, empty], empty.sessionId, open.sessionId);
    expect(kept).toBe(open);

    // A duplicate that was already paid is money taken: it is left alone.
    const paid = settleSession(duplicate, "CASH", 100000);
    expect(foldDuplicateTable([open, paid], paid.sessionId, open.sessionId)).toEqual([open, paid]);
  });

  it("refuses merges across outlets, settled tables and empty sources", () => {
    const target = freshSession("T1");
    const empty = freshSession("T2");
    const other = openTableSession({
      ...SECOND_OUTLET,
      tableId: "T3",
      guestCount: 2,
      serverName: "Ravi",
    });
    const stocked = addItemToSession(other, { ...MENU[0], price: 200 }, 1);

    expect(() => mergeTableSessions([target], target.sessionId, target.sessionId)).toThrow();
    expect(() => mergeTableSessions([target, empty], empty.sessionId, target.sessionId)).toThrow();
    expect(() =>
      mergeTableSessions([target, stocked], stocked.sessionId, target.sessionId)
    ).toThrow();
    expect(() => mergeTableSessions([target], "POS-missing", target.sessionId)).toThrow();

    const settled = settleSession(
      sendPendingToKitchen(addItemToSession(freshSession("T4"), MENU[0], 1)).session,
      "CASH",
      100000
    );
    const live = addItemToSession(freshSession("T5"), MENU[0], 1);
    expect(() =>
      mergeTableSessions([settled, live], live.sessionId, settled.sessionId)
    ).toThrow();
  });

  it("closes a shift with a cash variance and claims only its own bills", () => {
    const shift = openShift({ ...OUTLET, openedBy: "Meera", openingCash: 2000 });
    expect(() => openShift({ ...OUTLET, openedBy: "M", openingCash: 2000 })).toThrow();
    expect(() =>
      openShift({ ...OUTLET, openedBy: "Meera", openingCash: -1 })
    ).toThrow();

    const inShift = settleSession(
      sendPendingToKitchen(
        addItemToSession(
          openTableSession({
            ...OUTLET,
            tableId: "T1",
            guestCount: 2,
            serverName: "Asha",
            shiftId: shift.shiftId,
          }),
          { ...MENU[0], price: 1000 },
          1
        )
      ).session,
      "CASH",
      1100
    );
    const otherOutlet = settleSession(
      sendPendingToKitchen(
        addItemToSession(
          openTableSession({
            ...SECOND_OUTLET,
            tableId: "T2",
            guestCount: 2,
            serverName: "Ravi",
            shiftId: "SHIFT-other",
          }),
          { ...MENU[0], price: 1000 },
          1
        )
      ).session,
      "CASH",
      1100
    );

    const sessions = [inShift, otherOutlet];
    expect(getShiftSessions(shift, sessions)).toHaveLength(1);

    const { shift: closed, report } = closeShift(shift, sessions, {
      closedBy: "Meera",
      countedCash: 3000,
    });
    expect(report.cashSales).toBe(1050);
    expect(report.expectedCash).toBe(3050);
    expect(report.cashVariance).toBe(-50);
    expect(report.summary.settledBills).toBe(1);
    expect(report.openTablesAtClose).toBe(0);
    expect(() =>
      closeShift(closed, sessions, { closedBy: "Meera", countedCash: 3000 })
    ).toThrow();
  });

  it("restores an unfinished shift and drops a closed or malformed one", () => {
    const shift = openShift({ ...OUTLET, openedBy: "Meera", openingCash: 2000 });
    expect(restorePosShift(JSON.stringify(shift))?.shiftId).toBe(shift.shiftId);

    const { shift: closed } = closeShift(shift, [], { closedBy: "Meera", countedCash: 2000 });
    expect(restorePosShift(JSON.stringify(closed))).toBeNull();
    expect(restorePosShift("not-json")).toBeNull();
    expect(restorePosShift(null)).toBeNull();
    expect(restorePosShift(JSON.stringify({ ...shift, shiftId: "nope" }))).toBeNull();
  });
});
