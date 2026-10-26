import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerUser } from "@/lib/server/auth";
import { one, run } from "@/lib/server/pg";
import { listPosOutlets } from "@/lib/server/posCatalog";
import {
  cancelOrderByCustomer,
  changeRestaurantOrderStatus,
  getPublicRestaurantOrder,
  listRestaurantOrders,
  OrderRequestError,
  placeRestaurantOrder,
} from "@/lib/server/restaurantOrderStore";
import {
  createMenuCategory,
  deleteMenuItem,
  getPublishedRestaurantBySlug,
  saveMenuItem,
  setMenuItemAvailability,
  updateManagedRestaurant,
  type ManagedMenuItem,
} from "@/lib/server/restaurantStore";
import { hasTestDatabase, resetTestDatabase, startTestDatabase, stopTestDatabase } from "./support/testDb";

const SLUG = "jagadamba-maratha-khanawali";

describe.skipIf(!hasTestDatabase)("restaurant ordering", () => {
  beforeAll(startTestDatabase);
  afterAll(stopTestDatabase);
  beforeEach(resetTestDatabase);

  let keySeq = 0;
  const newKey = () => `test-key-${Date.now()}-${keySeq++}`.padEnd(20, "x");

  async function createOwner(email = "owner@jagadamba.test") {
    return registerUser({ email, password: "135790" });
  }

  /** A published restaurant taking takeaway and delivery orders, with one dish. */
  async function openRestaurant() {
    const owner = await createOwner();
    const now = new Date().toISOString();
    await run(
      `INSERT INTO managed_restaurants
       (id, owner_user_id, slug, name, status, published_at, accepting_orders, takeaway_enabled,
        dine_in_enabled, delivery_enabled, service_areas, minimum_order_paise, delivery_fee_paise,
        tax_enabled, tax_rate_bps, phone, created_at, updated_at)
       VALUES ('rst_jagadamba', $1, $2, 'Jagadamba Maratha Khanawali', 'published', $3, 1, 1,
        0, 1, '["Wadi"]'::jsonb, 15000, 2000, 1, 500, '08442 200100', $3, $3)`,
      [owner.id, SLUG, now]
    );
    await run(
      `INSERT INTO restaurant_memberships (restaurant_id, user_id, role, granted_at, granted_by)
       VALUES ('rst_jagadamba', $1, 'owner', $2, $1)`,
      [owner.id, now]
    );
    const category = await createMenuCategory(owner.id, "rst_jagadamba", { name: "Biriyani", visible: true });
    const item = await saveMenuItem(owner.id, "rst_jagadamba", {
      categoryId: category.id,
      name: "Chicken Biriyani",
      pricePaise: 6_000,
      published: true,
      available: true,
      variants: [
        { name: "Half", priceDeltaPaise: 0 },
        { name: "Full", priceDeltaPaise: 4_000 },
      ],
      addons: [{ name: "Boiled egg", pricePaise: 1_500 }],
    });
    return { owner, restaurantId: "rst_jagadamba", category, item };
  }

  function full(item: ManagedMenuItem) {
    return item.variants.find((variant) => variant.name === "Full")!.id;
  }

  /** Two Full plates with egg, takeaway: 2 × (60 + 40 + 15) = ₹230 + 5% tax = ₹241.50. */
  function takeawayOrder(item: ManagedMenuItem, overrides: Record<string, unknown> = {}) {
    return {
      idempotencyKey: newKey(),
      customerName: "Ravi Patil",
      customerPhone: "+91 98450 12345",
      fulfilment: "takeaway",
      lines: [{ itemId: item.id, variantId: full(item), addonIds: [item.addons[0].id], quantity: 2 }],
      expectedTotalPaise: 24_150,
      ...overrides,
    };
  }

  async function rejection(promise: Promise<unknown>): Promise<OrderRequestError> {
    const error = await promise.then(
      () => null,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(OrderRequestError);
    return error as OrderRequestError;
  }

  it("prices the order on the server and stores a snapshot of each line", async () => {
    const { item } = await openRestaurant();
    const { order, replayed } = await placeRestaurantOrder(SLUG, takeawayOrder(item), null);

    expect(replayed).toBe(false);
    expect(order.orderNumber).toBe(1);
    expect(order.status).toBe("placed");
    expect(order).toMatchObject({ subtotalPaise: 23_000, deliveryFeePaise: 0, taxPaise: 1_150, totalPaise: 24_150 });
    expect(order.paymentMethod).toBe("pay_at_restaurant");
    expect(order.lines[0]).toMatchObject({
      itemName: "Chicken Biriyani",
      variantName: "Full",
      unitPricePaise: 11_500,
      quantity: 2,
      lineTotalPaise: 23_000,
    });
    expect(order.lines[0].addons).toEqual([expect.objectContaining({ name: "Boiled egg", pricePaise: 1_500 })]);
    // The customer's view never carries their phone or address back out.
    expect(JSON.stringify(order)).not.toContain("98450");
  });

  it("stores one order when the same checkout is submitted twice at once", async () => {
    const { owner, restaurantId, item } = await openRestaurant();
    const request = takeawayOrder(item);
    const [first, second] = await Promise.all([
      placeRestaurantOrder(SLUG, request, null),
      placeRestaurantOrder(SLUG, request, null),
    ]);

    expect(first.order.id).toBe(second.order.id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    const page = await listRestaurantOrders(owner.id, restaurantId, { view: "all" });
    expect(page.orders).toHaveLength(1);
  });

  it("refuses to reuse a checkout key for a different cart", async () => {
    const { item } = await openRestaurant();
    const request = takeawayOrder(item);
    await placeRestaurantOrder(SLUG, request, null);
    const error = await rejection(placeRestaurantOrder(SLUG, { ...request, customerName: "Someone Else" }, null));
    expect(error.code).toBe("conflict");
  });

  it("numbers concurrent orders without gaps or duplicates", async () => {
    const { item } = await openRestaurant();
    const placed = await Promise.all(
      Array.from({ length: 5 }, () => placeRestaurantOrder(SLUG, takeawayOrder(item), null))
    );
    expect(placed.map((entry) => entry.order.orderNumber).sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it("returns the new total when the price changed, and accepts it on retry with the same key", async () => {
    const { owner, restaurantId, category, item } = await openRestaurant();
    const request = takeawayOrder(item);
    await saveMenuItem(owner.id, restaurantId, {
      id: item.id,
      revision: item.revision,
      categoryId: category.id,
      name: item.name,
      pricePaise: 7_000,
      published: true,
      available: true,
      variants: item.variants,
      addons: item.addons,
    });

    const error = await rejection(placeRestaurantOrder(SLUG, request, null));
    expect(error.code).toBe("price_changed");
    expect(error.quote?.totalPaise).toBe(26_250);

    const retried = await placeRestaurantOrder(SLUG, { ...request, expectedTotalPaise: 26_250 }, null);
    expect(retried.order.totalPaise).toBe(26_250);
  });

  it("ignores prices sent by the browser", async () => {
    const { item } = await openRestaurant();
    const tampered = takeawayOrder(item, {
      expectedTotalPaise: 100,
      lines: [{ itemId: item.id, variantId: full(item), addonIds: [], quantity: 1, unitPricePaise: 1 }],
    });
    const error = await rejection(placeRestaurantOrder(SLUG, tampered, null));
    expect(error.code).toBe("price_changed");
    expect(error.quote?.totalPaise).toBe(10_500);
  });

  it("refuses a dish, portion or add-on that is not on sale", async () => {
    const { owner, restaurantId, item } = await openRestaurant();
    const bogusAddon = await rejection(
      placeRestaurantOrder(SLUG, takeawayOrder(item, {
        lines: [{ itemId: item.id, variantId: full(item), addonIds: ["add_other"], quantity: 1 }],
      }), null)
    );
    expect(bogusAddon.code).toBe("unavailable");

    await setMenuItemAvailability(owner.id, restaurantId, { id: item.id, available: false, revision: item.revision });
    const soldOut = await rejection(placeRestaurantOrder(SLUG, takeawayOrder(item), null));
    expect(soldOut.code).toBe("unavailable");
  });

  it("refuses orders while paused, outside hours, or for a service the restaurant does not offer", async () => {
    const { owner, restaurantId, item } = await openRestaurant();
    const dineIn = await rejection(placeRestaurantOrder(SLUG, takeawayOrder(item, { fulfilment: "dine_in" }), null));
    expect(dineIn.code).toBe("closed");

    // Monday 12:00 in India; the restaurant opens only in the evening.
    const mondayNoon = new Date("2025-06-02T06:30:00Z");
    await updateManagedRestaurant(owner.id, restaurantId, {
      hours: [{ weekday: 1, opensAt: "18:00", closesAt: "23:00", isClosed: false }],
    });
    const closed = await rejection(placeRestaurantOrder(SLUG, takeawayOrder(item), null, mondayNoon));
    expect(closed.code).toBe("closed");
    const evening = await placeRestaurantOrder(SLUG, takeawayOrder(item), null, new Date("2025-06-02T13:30:00Z"));
    expect(evening.order.status).toBe("placed");

    await updateManagedRestaurant(owner.id, restaurantId, { acceptingOrders: false, hours: [] });
    const paused = await rejection(placeRestaurantOrder(SLUG, takeawayOrder(item), null));
    expect(paused.code).toBe("closed");
  });

  it("enforces delivery areas and the delivery minimum, and charges the delivery fee", async () => {
    const { item } = await openRestaurant();
    const delivery = (overrides: Record<string, unknown>) =>
      takeawayOrder(item, { fulfilment: "delivery", deliveryAddress: "Near Kismat Talkies, Wadi", serviceArea: "Wadi", ...overrides });

    const outside = await rejection(placeRestaurantOrder(SLUG, delivery({ serviceArea: "Kalaburagi" }), null));
    expect(outside.code).toBe("invalid");

    const small = delivery({
      lines: [{ itemId: item.id, variantId: item.variants[0].id, addonIds: [], quantity: 1 }],
      expectedTotalPaise: 8_300,
    });
    const belowMinimum = await rejection(placeRestaurantOrder(SLUG, small, null));
    expect(belowMinimum.message).toMatch(/minimum/);

    // ₹230 food + ₹11.50 tax on food only + ₹20 delivery.
    const { order } = await placeRestaurantOrder(SLUG, delivery({ expectedTotalPaise: 26_150 }), null);
    expect(order).toMatchObject({ deliveryFeePaise: 2_000, taxPaise: 1_150, totalPaise: 26_150, paymentMethod: "pay_on_delivery" });
  });

  it("keeps a past order unchanged after the dish is renamed, repriced or deleted", async () => {
    const { owner, restaurantId, category, item } = await openRestaurant();
    const { order } = await placeRestaurantOrder(SLUG, takeawayOrder(item), null);

    await saveMenuItem(owner.id, restaurantId, {
      id: item.id,
      revision: item.revision,
      categoryId: category.id,
      name: "Chicken Dum Biriyani",
      pricePaise: 9_000,
      published: true,
    });
    expect((await getPublicRestaurantOrder(order.id))?.lines[0]).toMatchObject({
      itemName: "Chicken Biriyani",
      unitPricePaise: 11_500,
    });

    await deleteMenuItem(owner.id, restaurantId, item.id);
    const after = await getPublicRestaurantOrder(order.id);
    expect(after?.totalPaise).toBe(24_150);
    expect(after?.lines[0]).toMatchObject({ itemName: "Chicken Biriyani", variantName: "Full", lineTotalPaise: 23_000 });
  });

  it("moves an order through the kitchen once, even from two devices", async () => {
    const { owner, restaurantId, item } = await openRestaurant();
    const { order } = await placeRestaurantOrder(SLUG, takeawayOrder(item), null);
    const accept = () => changeRestaurantOrderStatus(owner.id, restaurantId, { orderId: order.id, from: "placed", to: "accepted" });

    const results = await Promise.allSettled([accept(), accept()]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
    expect((lost.reason as OrderRequestError).code).toBe("conflict");

    const skip = changeRestaurantOrderStatus(owner.id, restaurantId, { orderId: order.id, from: "accepted", to: "completed" });
    await expect(skip).rejects.toThrow(/not allowed/);
    const prototypeKey = changeRestaurantOrderStatus(owner.id, restaurantId, { orderId: order.id, from: "constructor", to: "completed" });
    await expect(prototypeKey).rejects.toThrow(/not allowed/);

    for (const [from, to] of [["accepted", "preparing"], ["preparing", "ready"], ["ready", "completed"]] as const) {
      await changeRestaurantOrderStatus(owner.id, restaurantId, { orderId: order.id, from, to });
    }
    expect((await getPublicRestaurantOrder(order.id))?.status).toBe("completed");
    const audit = await one<{ count: string }>(
      "SELECT COUNT(*) AS count FROM restaurant_audit WHERE subject = $1 AND action = 'ORDER_STATUS_CHANGED'",
      [order.id]
    );
    expect(Number(audit?.count)).toBe(4);
    expect((await listRestaurantOrders(owner.id, restaurantId, { view: "active" })).orders).toEqual([]);
  });

  it("lets the customer cancel only before the restaurant accepts", async () => {
    const { owner, restaurantId, item } = await openRestaurant();
    const first = (await placeRestaurantOrder(SLUG, takeawayOrder(item), null)).order;
    expect((await cancelOrderByCustomer(first.id)).status).toBe("cancelled");
    // A repeated tap is harmless.
    expect((await cancelOrderByCustomer(first.id)).status).toBe("cancelled");

    const second = (await placeRestaurantOrder(SLUG, takeawayOrder(item), null)).order;
    await changeRestaurantOrderStatus(owner.id, restaurantId, { orderId: second.id, from: "placed", to: "accepted" });
    expect((await rejection(cancelOrderByCustomer(second.id))).code).toBe("conflict");
    expect((await rejection(cancelOrderByCustomer("ord_not-a-real-order"))).code).toBe("not_found");
  });

  it("keeps each restaurant's orders private to its own staff", async () => {
    const { restaurantId, item } = await openRestaurant();
    const { order } = await placeRestaurantOrder(SLUG, takeawayOrder(item), null);
    const stranger = await createOwner("stranger@jagadamba.test");

    await expect(listRestaurantOrders(stranger.id, restaurantId)).rejects.toThrow(/do not have access/i);
    await expect(
      changeRestaurantOrderStatus(stranger.id, restaurantId, { orderId: order.id, from: "placed", to: "accepted" })
    ).rejects.toThrow(/do not have access/i);
  });

  it("pages older orders with a cursor that never repeats or skips one", async () => {
    const { owner, restaurantId, item } = await openRestaurant();
    for (let index = 0; index < 5; index += 1) {
      await placeRestaurantOrder(SLUG, takeawayOrder(item), null, new Date(Date.UTC(2025, 5, 2, 14, index)));
    }
    const first = await listRestaurantOrders(owner.id, restaurantId, { view: "all", limit: 2 });
    const second = await listRestaurantOrders(owner.id, restaurantId, { view: "all", limit: 2, before: first.nextCursor });
    const third = await listRestaurantOrders(owner.id, restaurantId, { view: "all", limit: 2, before: second.nextCursor });
    const numbers = [first, second, third].flatMap((page) => page.orders.map((entry) => entry.orderNumber));
    expect(numbers).toEqual([5, 4, 3, 2, 1]);
    expect(third.nextCursor).toBeNull();
    await expect(listRestaurantOrders(owner.id, restaurantId, { before: "x|'; DROP TABLE users;--" })).rejects.toThrow(/cursor/);
  });

  it("does not lose a setting when two partial saves land together", async () => {
    const { owner, restaurantId } = await openRestaurant();
    await Promise.all([
      updateManagedRestaurant(owner.id, restaurantId, { acceptingOrders: false }),
      updateManagedRestaurant(owner.id, restaurantId, { description: "Home-style Maratha food" }),
    ]);
    const saved = (await getPublishedRestaurantBySlug(SLUG))!;
    expect(saved.acceptingOrders).toBe(false);
    expect(saved.description).toBe("Home-style Maratha food");
  });

  it("keeps the FSSAI licence and GSTIN printed on bills, as typed on a phone, and refuses typos", async () => {
    const { owner, restaurantId } = await openRestaurant();
    const saved = await updateManagedRestaurant(owner.id, restaurantId, {
      fssaiNumber: " 1122 3344 5566 77 ",
      gstin: "29abcde1234f1z5",
    });
    expect(saved).toMatchObject({ fssaiNumber: "11223344556677", gstin: "29ABCDE1234F1Z5" });
    // A save that leaves them out keeps them; the terminal bills with them.
    await updateManagedRestaurant(owner.id, restaurantId, { description: "Home-style" });
    const [outlet] = await listPosOutlets(owner.id);
    expect(outlet).toMatchObject({ fssaiNumber: "11223344556677", gstin: "29ABCDE1234F1Z5" });

    await expect(updateManagedRestaurant(owner.id, restaurantId, { fssaiNumber: "1234" })).rejects.toThrow(/14-digit/);
    await expect(updateManagedRestaurant(owner.id, restaurantId, { gstin: "29ABCDE1234" })).rejects.toThrow(/15-character/);
    // Emptying a field removes it from the bill.
    expect(await updateManagedRestaurant(owner.id, restaurantId, { gstin: "" })).toMatchObject({ gstin: "" });
  });
});
