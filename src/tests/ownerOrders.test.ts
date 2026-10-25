import { describe, expect, it } from "vitest";
import { initialOwnerOrders, ownerOrdersReducer, type OwnerOrder, type OwnerOrdersState } from "@/lib/ownerOrders";

function order(number: number, status: OwnerOrder["status"] = "placed", updatedAt = "2025-06-02T06:30:00.000Z"): OwnerOrder {
  return {
    id: `ord_${String(number).padStart(8, "0")}-0000-4000-8000-000000000000`,
    orderNumber: number,
    customerName: "Ravi",
    customerPhone: "9845012345",
    fulfilment: "takeaway",
    deliveryAddress: null,
    serviceArea: null,
    note: "",
    subtotalPaise: 12_000,
    deliveryFeePaise: 0,
    taxPaise: 0,
    totalPaise: 12_000,
    paymentMethod: "pay_at_restaurant",
    status,
    statusReason: null,
    placedAt: "2025-06-02T06:30:00.000Z",
    updatedAt,
    lines: [],
  };
}

function loaded(state: OwnerOrdersState, orders: OwnerOrder[], poll = false): OwnerOrdersState {
  return ownerOrdersReducer(state, { type: "loaded", request: state.request, orders, nextCursor: null, poll });
}

describe("ownerOrdersReducer", () => {
  it("drops a response for a view the owner already left", () => {
    const active = loaded(initialOwnerOrders, [order(1)]);
    const done = ownerOrdersReducer(active, { type: "view", view: "done" });
    const late = ownerOrdersReducer(done, { type: "loaded", request: active.request, orders: [order(9)], nextCursor: null, poll: true });
    expect(late).toBe(done);
  });

  it("announces orders that arrive on a refresh, not those on the first load", () => {
    const first = loaded(initialOwnerOrders, [order(1)]);
    expect(first.announcement).toBe("");
    const polled = loaded(first, [order(2), order(1)], true);
    expect(polled.announcement).toBe("New order #2.");
  });

  it("keeps a just-made change when a poll read the order before it", () => {
    const first = loaded(initialOwnerOrders, [order(1)]);
    const accepted = ownerOrdersReducer(first, { type: "changed", order: order(1, "accepted", "2025-06-02T06:31:00.000Z") });
    const stalePoll = loaded(accepted, [order(1, "placed")], true);
    expect(stalePoll.orders[0].status).toBe("accepted");
  });

  it("moves a finished order out of the active queue", () => {
    const first = loaded(initialOwnerOrders, [order(1, "ready"), order(2)]);
    const completed = ownerOrdersReducer(first, { type: "changed", order: order(1, "completed", "2025-06-02T07:00:00.000Z") });
    expect(completed.orders.map((entry) => entry.orderNumber)).toEqual([2]);
  });

  it("does not let a poll that read the order before it was completed put it back", () => {
    const first = loaded(initialOwnerOrders, [order(1, "ready", "2025-06-02T06:50:00.000Z"), order(2)]);
    const completed = ownerOrdersReducer(first, { type: "changed", order: order(1, "completed", "2025-06-02T07:00:00.000Z") });
    // The poll left before the change landed, so it still lists the order as ready.
    const stalePoll = loaded(completed, [order(1, "ready", "2025-06-02T06:50:00.000Z"), order(2)], true);
    expect(stalePoll.orders.map((entry) => entry.orderNumber)).toEqual([2]);
    // Once the server agrees, nothing is left to remember.
    const freshPoll = loaded(stalePoll, [order(2)], true);
    expect(freshPoll.orders.map((entry) => entry.orderNumber)).toEqual([2]);
    expect(freshPoll.departed).toEqual({});
  });

  it("keeps the list when a background refresh fails", () => {
    const first = loaded(initialOwnerOrders, [order(1)]);
    const failed = ownerOrdersReducer(first, { type: "loadFailed", request: first.request, message: "Offline", poll: true });
    expect(failed.load).toBe("ready");
    expect(failed.orders).toHaveLength(1);
    expect(failed.error).toBe("Offline");
  });

  it("tracks each order's change separately and releases it on failure", () => {
    let state = loaded(initialOwnerOrders, [order(1), order(2)]);
    state = ownerOrdersReducer(state, { type: "changing", id: order(1).id });
    state = ownerOrdersReducer(state, { type: "changing", id: order(1).id });
    expect(state.pending).toEqual([order(1).id]);
    state = ownerOrdersReducer(state, { type: "changeFailed", id: order(1).id, message: "Changed elsewhere" });
    expect(state.pending).toEqual([]);
  });

  it("appends older pages without duplicates", () => {
    const first = ownerOrdersReducer(
      ownerOrdersReducer(initialOwnerOrders, { type: "view", view: "done" }),
      { type: "loaded", request: 1, orders: [order(3, "completed")], nextCursor: "c", poll: false }
    );
    const more = ownerOrdersReducer(ownerOrdersReducer(first, { type: "loadingMore" }), {
      type: "more",
      request: first.request,
      orders: [order(3, "completed"), order(2, "completed")],
      nextCursor: null,
    });
    expect(more.orders.map((entry) => entry.orderNumber)).toEqual([3, 2]);
    expect(more.loadingMore).toBe(false);
  });
});
