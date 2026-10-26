import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerUser } from "@/lib/server/auth";
import { one, run } from "@/lib/server/pg";
import { listSalesHistory, SalesHistoryAccessError } from "@/lib/server/posHistory";
import { grantTeamAccess } from "@/lib/server/restaurantTeam";
import { loadPosState, syncPosState } from "@/lib/server/posStore";
import {
  addItemToSession,
  calculatePosBill,
  changeSettledPayment,
  openTableSession,
  reopenSettledSession,
  sendPendingToKitchen,
  setTableGuest,
  settleSession,
  type PosOutlet,
  type PosPaymentMethod,
  type PosTableSession,
} from "@/lib/pos/posEngine";
import { seedPosOutlet } from "./support/posRestaurant";
import {
  hasTestDatabase,
  resetTestDatabase,
  startTestDatabase,
  stopTestDatabase,
} from "./support/testDb";

describe.skipIf(!hasTestDatabase)("sales history", () => {
  beforeAll(startTestDatabase);
  afterAll(stopTestDatabase);
  beforeEach(resetTestDatabase);

  const PASSWORD = "135790";
  const HOUR = 3_600_000;

  async function owner() {
    const user = await registerUser({ email: "owner@sales.test", password: PASSWORD });
    return { user, outlet: await seedPosOutlet(user) };
  }

  function paidBill(
    outlet: PosOutlet,
    tableId: string,
    method: PosPaymentMethod,
    guest?: { name: string; phone: string }
  ): PosTableSession {
    let session = openTableSession({
      outletId: outlet.outletId,
      outletName: outlet.name,
      taxRateBps: outlet.taxRateBps,
      tableId,
      guestCount: 2,
      serverName: "Asha",
      leadGuest: guest,
    });
    session = sendPendingToKitchen(addItemToSession(session, outlet.menu[0], 1)).session;
    return settleSession(session, method, calculatePosBill(session).grandTotal);
  }

  function history(userId: string, outlet: PosOutlet, extra: Record<string, string> = {}) {
    const now = Date.now();
    return listSalesHistory(
      userId,
      new URLSearchParams({
        outletId: String(outlet.outletId),
        from: new Date(now - 24 * HOUR).toISOString(),
        to: new Date(now + HOUR).toISOString(),
        ...extra,
      })
    );
  }

  it("numbers each paid bill per restaurant and keeps the number through a correction and a reopen", async () => {
    const { user, outlet } = await owner();
    const first = paidBill(outlet, "T1", "CASH");
    const second = paidBill(outlet, "T2", "UPI");
    const open = openTableSession({
      outletId: outlet.outletId,
      outletName: outlet.name,
      taxRateBps: outlet.taxRateBps,
      tableId: "T3",
      guestCount: 1,
      serverName: "Asha",
    });
    const synced = await syncPosState(user.id, { sessions: [first, second, open] });
    expect(synced.billNumbers[first.sessionId]).toBe(1);
    expect(synced.billNumbers[second.sessionId]).toBe(2);
    expect(synced.billNumbers[open.sessionId]).toBeUndefined();

    const stored = synced.sessions.find((session) => session.sessionId === first.sessionId)!;
    const reopened = reopenSettledSession(
      changeSettledPayment(stored, "UPI", "GPay", null),
      "Ordered more",
      null,
      []
    );
    const again = await syncPosState(user.id, { sessions: [reopened] });
    const back = again.sessions.find((session) => session.sessionId === first.sessionId)!;
    const resettled = settleSession(back, "CARD", calculatePosBill(back).grandTotal);
    const final = await syncPosState(user.id, { sessions: [resettled] });
    expect(final.billNumbers[first.sessionId]).toBe(1);
  });

  it("lists paid bills newest first with the period's totals by payment", async () => {
    const { user, outlet } = await owner();
    const cash = paidBill(outlet, "T1", "CASH", { name: "Ramesh", phone: "9876543210" });
    const upi = paidBill(outlet, "T2", "UPI", { name: "Sunita", phone: "9123456789" });
    upi.payment = { ...upi.payment!, settledAt: new Date(Date.parse(cash.payment!.settledAt) + 60_000).toISOString() };
    const open = openTableSession({
      outletId: outlet.outletId,
      outletName: outlet.name,
      taxRateBps: outlet.taxRateBps,
      tableId: "T3",
      guestCount: 1,
      serverName: "Asha",
    });
    await syncPosState(user.id, { sessions: [cash, upi, open] });

    const result = await history(user.id, outlet);
    const total = calculatePosBill(cash).grandTotal;
    expect(result.entries.map((entry) => entry.session.tableId)).toEqual(["T2", "T1"]);
    expect(result.summary).toEqual({ bills: 2, total: total * 2, byMethod: { CASH: total, CARD: 0, UPI: total } });
    expect(result.entries[0]).toMatchObject({ billNumber: 2, grandTotal: total });
    expect(result.entries[0].claimCode).toMatch(/^[A-Z0-9]{10}$/);

    const yesterday = await listSalesHistory(
      user.id,
      new URLSearchParams({
        outletId: String(outlet.outletId),
        from: new Date(Date.now() - 48 * HOUR).toISOString(),
        to: new Date(Date.now() - 24 * HOUR).toISOString(),
      })
    );
    expect(yesterday.entries).toEqual([]);
  });

  it("finds a bill by guest name, mobile digits, table, bill number or exact amount", async () => {
    const { user, outlet } = await owner();
    const ramesh = paidBill(outlet, "T1", "CASH", { name: "Ramesh Patil", phone: "9876543210" });
    const sunita = paidBill(outlet, "T5", "UPI", { name: "Sunita", phone: "9123456789" });
    await syncPosState(user.id, { sessions: [ramesh, sunita] });
    const tables = async (q: string) =>
      (await history(user.id, outlet, { q })).entries.map((entry) => entry.session.tableId);

    expect(await tables("ramesh")).toEqual(["T1"]);
    expect(await tables("43210")).toEqual(["T1"]);
    expect(await tables("t5")).toEqual(["T5"]);
    expect(await tables("2")).toEqual(["T5"]);
    expect((await tables(String(calculatePosBill(ramesh).grandTotal))).sort()).toEqual(["T1", "T5"]);
    expect(await tables("100%_")).toEqual([]);
  });

  it("pages through older bills without repeating or skipping any", async () => {
    const { user, outlet } = await owner();
    const bills = ["T1", "T2", "T3"].map((table, index) => {
      const bill = paidBill(outlet, table, "CASH");
      bill.payment = { ...bill.payment!, settledAt: new Date(Date.now() - (index + 1) * 60_000).toISOString() };
      return bill;
    });
    await syncPosState(user.id, { sessions: bills });

    const first = await history(user.id, outlet, { limit: "2" });
    expect(first.entries.map((entry) => entry.session.tableId)).toEqual(["T1", "T2"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await history(user.id, outlet, { limit: "2", before: first.nextCursor! });
    expect(second.entries.map((entry) => entry.session.tableId)).toEqual(["T3"]);
    expect(second.nextCursor).toBeNull();
  });

  it("fills in totals for bills synced before totals were stored", async () => {
    const { user, outlet } = await owner();
    const bill = paidBill(outlet, "T1", "CASH");
    await syncPosState(user.id, { sessions: [bill] });
    await run("UPDATE pos_sessions SET grand_total = NULL");
    expect((await history(user.id, outlet)).summary?.total).toBe(calculatePosBill(bill).grandTotal);
    expect(await one("SELECT grand_total FROM pos_sessions")).toEqual({
      grand_total: calculatePosBill(bill).grandTotal,
    });
  });

  it("shows a restaurant's bills only to accounts that bill for it", async () => {
    const { outlet } = await owner();
    const stranger = await registerUser({ email: "stranger@sales.test", password: PASSWORD });
    await expect(history(stranger.id, outlet)).rejects.toBeInstanceOf(SalesHistoryAccessError);
  });

  it("returns every open table and the tables just synced, however many old bills there are", async () => {
    const { user, outlet } = await owner();
    const old = paidBill(outlet, "T1", "CASH");
    await syncPosState(user.id, { sessions: [old] });
    // 120 older closed bills, copied straight in: far more than the floor returns.
    await run(
      `INSERT INTO pos_sessions (id, user_id, shift_id, outlet_id, outlet_name, table_id, guest_count,
         server_name, opened_at, status, discount_percent, service_charge_percent, next_kot_number,
         payment_method, payment_amount_tendered, payment_change_due, payment_settled_at, synced_at, revision)
       SELECT 'POS-old-' || n, user_id, NULL, outlet_id, outlet_name, 'T2', 1, 'Asha',
         '2026-01-01T10:00:00.000Z', 'SETTLED', 0, 0, 2, 'CASH', 100, 0,
         '2026-01-01T11:00:00.000Z', synced_at, 1
       FROM pos_sessions, generate_series(1, 120) AS n WHERE id = $1`,
      [old.sessionId]
    );
    const table = setTableGuest(
      openTableSession({
        outletId: outlet.outletId,
        outletName: outlet.name,
        taxRateBps: outlet.taxRateBps,
        tableId: "T4",
        guestCount: 2,
        serverName: "Asha",
      }),
      1,
      { name: "Late", phone: "" }
    );
    const synced = await syncPosState(user.id, { sessions: [table] });
    expect(synced.sessions.some((session) => session.sessionId === table.sessionId)).toBe(true);
    const floor = await loadPosState(user.id);
    expect(floor.sessions.filter((session) => session.status === "OPEN").map((s) => s.tableId)).toEqual(["T4"]);
    expect(floor.sessions.length).toBeLessThanOrEqual(101);
  });

  describe("a waiter", () => {
    async function restaurantWithWaiter() {
      const { user, outlet } = await owner();
      const waiter = await registerUser({ email: "hemant@sales.test", password: PASSWORD });
      const restaurantId = String(
        (await one<{ id: string }>("SELECT id FROM managed_restaurants LIMIT 1"))!.id
      );
      await grantTeamAccess(user.id, restaurantId, { email: waiter.email, role: "staff" });
      return { user, waiter, outlet };
    }

    it("cannot list the restaurant's bills or see its takings", async () => {
      const { user, waiter, outlet } = await restaurantWithWaiter();
      await syncPosState(user.id, { sessions: [paidBill(outlet, "T1", "CASH")] });

      await expect(history(waiter.id, outlet)).rejects.toBeInstanceOf(SalesHistoryAccessError);
      // Nor by searching a name, a table or an amount: only a bill number or a whole mobile.
      for (const q of ["", "Asha", "T1", "Ram", "12"]) {
        const lookup = history(waiter.id, outlet, { q });
        if (q === "12") await expect(lookup).resolves.toMatchObject({ scope: "lookup" });
        else await expect(lookup).rejects.toBeInstanceOf(SalesHistoryAccessError);
      }
      expect((await history(waiter.id, outlet, { q: "1" })).summary).toBeNull();
    });

    it("finds one bill by its number or the guest's mobile, and nothing else", async () => {
      const { user, waiter, outlet } = await restaurantWithWaiter();
      await syncPosState(user.id, {
        sessions: [paidBill(outlet, "T1", "CASH", { name: "Ramesh", phone: "9876543210" })],
      });
      await syncPosState(waiter.id, { sessions: [paidBill(outlet, "T2", "UPI")] });

      // Bill 2 is the waiter's own; bill 1 is the owner's and is not theirs to look up.
      const own = await history(waiter.id, outlet, { q: "2" });
      expect(own.entries.map((entry) => entry.session.tableId)).toEqual(["T2"]);
      expect(own.nextCursor).toBeNull();
      expect((await history(waiter.id, outlet, { q: "1" })).entries).toEqual([]);

      // The guest gives their number, so their bill can be sent again from any phone.
      const byMobile = await history(waiter.id, outlet, { q: "98765 43210" });
      expect(byMobile.entries.map((entry) => entry.session.tableId)).toEqual(["T1"]);
      // Part of a number is not a number: it is read as a bill number and finds nothing.
      expect((await history(waiter.id, outlet, { q: "98765" })).entries).toEqual([]);
    });

    it("is sent back only the paid bills it took, not the restaurant's", async () => {
      const { user, waiter, outlet } = await restaurantWithWaiter();
      await syncPosState(user.id, { sessions: [paidBill(outlet, "T1", "CASH")] });
      await syncPosState(waiter.id, { sessions: [paidBill(outlet, "T2", "UPI")] });

      const waiterFloor = await loadPosState(waiter.id);
      expect(waiterFloor.sessions.map((session) => session.tableId)).toEqual(["T2"]);
      const ownerFloor = await loadPosState(user.id);
      expect(ownerFloor.sessions.map((session) => session.tableId).sort()).toEqual(["T1", "T2"]);
    });

    it("keeps one open bill per table when two phones seat it at the same moment", async () => {
      const { user, waiter, outlet } = await restaurantWithWaiter();
      const seat = (serverName: string) =>
        openTableSession({
          outletId: outlet.outletId,
          outletName: outlet.name,
          taxRateBps: outlet.taxRateBps,
          tableId: "T3",
          guestCount: 2,
          serverName,
        });
      // Warm two connections so both saves really overlap.
      await Promise.all([one("SELECT pg_sleep(0.2)"), one("SELECT pg_sleep(0.2)")]);
      const [ownerPush, waiterPush] = await Promise.all([
        syncPosState(user.id, { sessions: [seat("Owner")] }),
        syncPosState(waiter.id, { sessions: [addItemToSession(seat("Hemant"), outlet.menu[0], 1)] }),
      ]);
      const taken = [...ownerPush.taken, ...waiterPush.taken];
      expect(taken).toHaveLength(1);
      // The phone that lost is sent the bill that is open, so it can add its order to it.
      const loser = ownerPush.taken.length > 0 ? ownerPush : waiterPush;
      expect(loser.sessions.map((session) => session.sessionId)).toContain(taken[0].openSessionId);
      const open = (await loadPosState(user.id)).sessions.filter(
        (session) => session.status === "OPEN" && session.tableId === "T3"
      );
      expect(open.map((session) => session.sessionId)).toEqual([taken[0].openSessionId]);
    });

    it("refuses moving a bill onto a table that is already open, without merging the two", async () => {
      const { user, waiter, outlet } = await restaurantWithWaiter();
      const seat = (tableId: string) =>
        openTableSession({
          outletId: outlet.outletId,
          outletName: outlet.name,
          taxRateBps: outlet.taxRateBps,
          tableId,
          guestCount: 2,
          serverName: "Asha",
        });
      const t1 = seat("T1");
      await syncPosState(user.id, { sessions: [t1, seat("T2")] });
      const moved = { ...t1, tableId: "T2", revision: 1 };
      const push = await syncPosState(waiter.id, { sessions: [moved] });
      expect(push.taken).toEqual([]);
      expect(push.rejected).toEqual([
        { sessionId: t1.sessionId, reason: "Table T2 is already open on another phone." },
      ]);
      // The bill stays where it was.
      expect(push.sessions.find((session) => session.sessionId === t1.sessionId)?.tableId).toBe("T1");
    });

    it("still sees every open table, because the floor is shared", async () => {
      const { user, waiter, outlet } = await restaurantWithWaiter();
      const open = openTableSession({
        outletId: outlet.outletId,
        outletName: outlet.name,
        taxRateBps: outlet.taxRateBps,
        tableId: "T5",
        guestCount: 2,
        serverName: "Asha",
      });
      await syncPosState(user.id, { sessions: [open] });
      expect((await loadPosState(waiter.id)).sessions.map((session) => session.tableId)).toEqual(["T5"]);
    });
  });
});
