import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasTestDatabase,
  resetTestDatabase,
  startTestDatabase,
  stopTestDatabase,
} from "./support/testDb";
import { outletInput } from "./support/posFixture";
import { seedPosOutlet } from "./support/posRestaurant";
import { run } from "@/lib/server/pg";
import { registerUser } from "@/lib/server/auth";
import { listNotifications, saveOrder, sweepScheduledOrders } from "@/lib/server/accountStore";
import { loadPosState, syncPosState } from "@/lib/server/posStore";
import { createDemoOrder, DEMO_PAYMENT_METHODS } from "@/lib/checkout";
import {
  addItemToSession,
  openTableSession,
  sendPendingToKitchen,
} from "@/lib/pos/posEngine";

// Demo orders are priced from the legacy fictional catalog, which the app no longer ships.
vi.mock("@/data/zomatoReconstructedData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/zomatoReconstructedData")>()),
  ...(await import("./support/legacyCatalog")).LEGACY_CATALOG,
}));

const CREDENTIALS = { email: "chef@krave.test", password: "correct-horse-battery" };
const CHECKOUT = {
  items: [{ itemId: "ctl_820099425", quantity: 1, optionIds: ["opt_500g"] }],
  addressId: "addr_cp_514",
  paymentMethod: DEMO_PAYMENT_METHODS[0],
  couponCode: "KRAVE50",
  isGoldMember: true,
  riderTip: 20,
};

describe.skipIf(!hasTestDatabase)("foundations", () => {

beforeAll(async () => {
  await startTestDatabase();
});

afterAll(async () => {
  await stopTestDatabase();
});

beforeEach(async () => {
  await resetTestDatabase();
});

describe("Terminal sync is all-or-nothing per table", () => {
  it("keeps the stored table intact when writing its update fails part-way", async () => {
    const user = await registerUser(CREDENTIALS);
    const outlet = await seedPosOutlet(user);
    const MENU = outlet.menu;
    const session = sendPendingToKitchen(
      addItemToSession(
        openTableSession({ ...outletInput(outlet), tableId: "T1", guestCount: 2, serverName: "Asha" }),
        MENU[0],
        2
      )
    ).session;
    const [stored] = (await syncPosState(user.id, { sessions: [session], shift: null })).sessions;
    expect(stored.revision).toBe(1);

    // Simulate a storage failure that strikes after the old rows were already replaced:
    // the second line of the update cannot be written.
    await run(`
      CREATE OR REPLACE FUNCTION fail_second_line() RETURNS trigger AS $$
      BEGIN
        IF NEW.item_id = '${MENU[1].itemId}' THEN RAISE EXCEPTION 'disk I/O error'; END IF;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER fail_second_line BEFORE INSERT ON pos_lines
      FOR EACH ROW EXECUTE FUNCTION fail_second_line();
    `);
    try {
      const update = addItemToSession({ ...session, revision: 1 }, MENU[1], 1);
      const result = await syncPosState(user.id, { sessions: [update], shift: null });

      expect(result.rejected.map((entry) => entry.sessionId)).toEqual([session.sessionId]);
      const [after] = (await loadPosState(user.id)).sessions;
      // Without the per-table savepoint this commits revision 2 with one line and no ticket.
      expect(after.revision).toBe(1);
      expect(after.lines).toHaveLength(1);
      expect(after.tickets).toHaveLength(1);
    } finally {
      await run("DROP TRIGGER IF EXISTS fail_second_line ON pos_lines");
    }
  });
});

describe("Scheduled-order sweep", () => {
  it("does not announce an order that another sweep started first", async () => {
    const user = await registerUser(CREDENTIALS);
    const first = createDemoOrder({ ...CHECKOUT, scheduledSlot: "Tomorrow, 12:30 PM" });
    const second = createDemoOrder({ ...CHECKOUT, scheduledSlot: "Tonight, 8:00 PM" });
    await saveOrder(user.id, first, { addressId: CHECKOUT.addressId, idempotencyKey: null });
    await saveOrder(user.id, second, { addressId: CHECKOUT.addressId, idempotencyKey: null });
    await run("UPDATE orders SET due_at = $1", [new Date(Date.now() - 1000).toISOString()]);

    // Another process (or tab) starts the remaining order between this sweep's read and its
    // write. A trigger on the first announcement stands in for that interleaving; it works
    // whichever order the sweep reaches first.
    await run(`
      CREATE OR REPLACE FUNCTION concurrent_sweep() RETURNS trigger AS $$
      BEGIN
        UPDATE orders SET stage = 'KITCHEN_PREPARING' WHERE stage = 'ORDER_CONFIRMED';
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER concurrent_sweep AFTER INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION concurrent_sweep();
    `);
    try {
      const started = await sweepScheduledOrders(user.id);
      expect(started).toHaveLength(1);
      expect([first.orderId, second.orderId]).toContain(started[0]);
      expect(await listNotifications(user.id)).toHaveLength(1);
    } finally {
      await run("DROP TRIGGER IF EXISTS concurrent_sweep ON notifications");
    }
  });

  it("rolls the stage back when its announcement cannot be written", async () => {
    const user = await registerUser(CREDENTIALS);
    const order = createDemoOrder({ ...CHECKOUT, scheduledSlot: "Tomorrow, 12:30 PM" });
    await saveOrder(user.id, order, { addressId: CHECKOUT.addressId, idempotencyKey: null });
    await run("UPDATE orders SET due_at = $1", [new Date(Date.now() - 1000).toISOString()]);
    await run(`
      CREATE OR REPLACE FUNCTION notifications_down() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'disk I/O error'; END; $$ LANGUAGE plpgsql;
      CREATE TRIGGER notifications_down BEFORE INSERT ON notifications
      FOR EACH ROW EXECUTE FUNCTION notifications_down();
    `);

    // Dropped in `finally`: truncation between tests does not remove a trigger, so one left
    // behind by a failing assertion would break every later insert on the shared branch.
    try {
      await expect(sweepScheduledOrders(user.id)).rejects.toThrow(/disk I\/O/);
    } finally {
      await run("DROP TRIGGER IF EXISTS notifications_down ON notifications");
    }
    // Still due, so the next read retries and announces it rather than starting it silently.
    expect(await sweepScheduledOrders(user.id)).toEqual([order.orderId]);
    expect(await listNotifications(user.id)).toHaveLength(1);
  });
});

});
