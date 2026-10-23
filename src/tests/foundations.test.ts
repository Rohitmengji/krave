import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { useTestDb } from "@/lib/server/db";
import { registerUser } from "@/lib/server/auth";
import { listNotifications, saveOrder, sweepScheduledOrders } from "@/lib/server/accountStore";
import { loadPosState, syncPosState } from "@/lib/server/posStore";
import { createDemoOrder, DEMO_PAYMENT_METHODS } from "@/lib/checkout";
import {
  addItemToSession,
  getPosMenu,
  getPosOutlets,
  openTableSession,
  sendPendingToKitchen,
} from "@/lib/pos/posEngine";

const CREDENTIALS = { email: "chef@krave.test", password: "correct-horse-battery" };
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

describe("Terminal sync is all-or-nothing per table", () => {
  const OUTLET_ID = getPosOutlets()[0].outletId;
  const MENU = getPosMenu(OUTLET_ID);

  it("keeps the stored table intact when writing its update fails part-way", async () => {
    const user = await registerUser(CREDENTIALS);
    const session = sendPendingToKitchen(
      addItemToSession(
        openTableSession({ outletId: OUTLET_ID, tableId: "T1", guestCount: 2, serverName: "Asha" }),
        MENU[0],
        2
      )
    ).session;
    const [stored] = syncPosState(user.id, { sessions: [session], shift: null }).sessions;
    expect(stored.revision).toBe(1);

    // Simulate a storage failure that strikes after the old rows were already replaced:
    // the second line of the update cannot be written.
    db.exec(`
      CREATE TRIGGER fail_second_line BEFORE INSERT ON pos_lines
      WHEN NEW.item_id = '${MENU[1].itemId}'
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;
    `);
    const update = addItemToSession({ ...session, revision: 1 }, MENU[1], 1);
    const result = syncPosState(user.id, { sessions: [update], shift: null });

    expect(result.rejected.map((entry) => entry.sessionId)).toEqual([session.sessionId]);
    const [after] = loadPosState(user.id).sessions;
    // Without the per-table savepoint this commits revision 2 with one line and no ticket.
    expect(after.revision).toBe(1);
    expect(after.lines).toHaveLength(1);
    expect(after.tickets).toHaveLength(1);
  });
});

describe("Scheduled-order sweep", () => {
  it("does not announce an order that another sweep started first", async () => {
    const user = await registerUser(CREDENTIALS);
    const first = createDemoOrder({ ...CHECKOUT, scheduledSlot: "Tomorrow, 12:30 PM" });
    const second = createDemoOrder({ ...CHECKOUT, scheduledSlot: "Tonight, 8:00 PM" });
    saveOrder(user.id, first, { addressId: CHECKOUT.addressId, idempotencyKey: null });
    saveOrder(user.id, second, { addressId: CHECKOUT.addressId, idempotencyKey: null });
    const past = new Date(Date.now() - 1000).toISOString();
    db.prepare("UPDATE orders SET due_at = ?").run(past);

    // Another process (or tab) starts the remaining order between this sweep's read and its
    // write. A trigger on the first announcement stands in for that interleaving; it works
    // whichever order the sweep reaches first.
    db.exec(`
      CREATE TRIGGER concurrent_sweep AFTER INSERT ON notifications
      BEGIN
        UPDATE orders SET stage = 'KITCHEN_PREPARING' WHERE stage = 'ORDER_CONFIRMED';
      END;
    `);

    const started = sweepScheduledOrders(user.id);
    expect(started).toHaveLength(1);
    expect([first.orderId, second.orderId]).toContain(started[0]);
    expect(listNotifications(user.id)).toHaveLength(1);
  });

  it("rolls the stage back when its announcement cannot be written", async () => {
    const user = await registerUser(CREDENTIALS);
    const order = createDemoOrder({ ...CHECKOUT, scheduledSlot: "Tomorrow, 12:30 PM" });
    saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });
    db.prepare("UPDATE orders SET due_at = ?").run(new Date(Date.now() - 1000).toISOString());
    db.exec(`
      CREATE TRIGGER notifications_down BEFORE INSERT ON notifications
      BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;
    `);

    expect(() => sweepScheduledOrders(user.id)).toThrow(/disk I\/O/);
    // Still due, so the next read retries and announces it rather than starting it silently.
    db.exec("DROP TRIGGER notifications_down");
    expect(sweepScheduledOrders(user.id)).toEqual([order.orderId]);
    expect(listNotifications(user.id)).toHaveLength(1);
  });
});
