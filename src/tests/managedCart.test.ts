import { describe, expect, it } from "vitest";
import {
  cartReducer,
  checkoutFlowReducer,
  EMPTY_CART,
  EMPTY_DETAILS,
  lineKey,
  parseCart,
  parseDetails,
  parseRecentOrders,
  priceCart,
  rememberOrder,
  reviewCheckout,
  serializeCart,
  type Cart,
  type OrderableItem,
} from "@/lib/managedCart";
import { MAX_LINE_QUANTITY, MAX_ORDER_LINES } from "@/lib/managedOrders";

const thali: OrderableItem = { id: "itm_thali", name: "Veg Thali", pricePaise: 12_000, discountedPricePaise: null, variants: [], addons: [] };
const biriyani: OrderableItem = {
  id: "itm_biriyani",
  name: "Chicken Biriyani",
  pricePaise: 6_000,
  discountedPricePaise: null,
  variants: [
    { id: "var_half", name: "Half", priceDeltaPaise: 0 },
    { id: "var_full", name: "Full", priceDeltaPaise: 4_000 },
  ],
  addons: [{ id: "add_egg", name: "Egg", pricePaise: 1_500 }],
};
const menu = new Map([thali, biriyani].map((item) => [item.id, item]));
const thaliLine = { itemId: thali.id, variantId: null, addonIds: [], quantity: 1 };

describe("cartReducer", () => {
  it("merges the same dish with the same add-ons, in any order, into one line", () => {
    let cart = cartReducer(EMPTY_CART, {
      type: "add",
      line: { itemId: biriyani.id, variantId: "var_full", addonIds: ["add_egg"], quantity: 1 },
    });
    cart = cartReducer(cart, {
      type: "add",
      line: { itemId: biriyani.id, variantId: "var_full", addonIds: ["add_egg"], quantity: 2 },
    });
    expect(cart.lines).toHaveLength(1);
    expect(cart.lines[0].quantity).toBe(3);
  });

  it("caps a line at the per-dish maximum", () => {
    let cart = cartReducer(EMPTY_CART, { type: "add", line: { ...thaliLine, quantity: MAX_LINE_QUANTITY } });
    const capped = cartReducer(cart, { type: "add", line: thaliLine });
    expect(capped).toBe(cart);
    cart = cartReducer(cart, { type: "setQuantity", key: lineKey(thaliLine), quantity: 99 });
    expect(cart.lines[0].quantity).toBe(MAX_LINE_QUANTITY);
  });

  it("removes a line when its quantity reaches zero and ignores non-integers", () => {
    const cart = cartReducer(EMPTY_CART, { type: "add", line: thaliLine });
    expect(cartReducer(cart, { type: "setQuantity", key: lineKey(thaliLine), quantity: 1.5 })).toBe(cart);
    expect(cartReducer(cart, { type: "setQuantity", key: lineKey(thaliLine), quantity: 0 }).lines).toEqual([]);
  });

  it("drops the checkout key whenever what would be ordered changes", () => {
    // A retry must reuse the key; a different order must not, or the server would refuse
    // it as a reused key (or, worse, replay the earlier order).
    const started = cartReducer(cartReducer(EMPTY_CART, { type: "add", line: thaliLine }), {
      type: "beginCheckout",
      key: "key-aaaaaaaaaaaaaaaa",
    });
    expect(cartReducer(started, { type: "beginCheckout", key: "key-bbbbbbbbbbbbbbbb" }).checkoutKey).toBe(
      "key-aaaaaaaaaaaaaaaa"
    );
    expect(cartReducer(started, { type: "add", line: thaliLine }).checkoutKey).toBeNull();
    expect(cartReducer(started, { type: "setNote", note: "less spicy" }).checkoutKey).toBeNull();
    expect(cartReducer(started, { type: "detailsChanged" }).checkoutKey).toBeNull();
    expect(cartReducer(started, { type: "remove", key: lineKey(thaliLine) }).checkoutKey).toBeNull();
  });
});

describe("parseCart", () => {
  it("round-trips a saved cart", () => {
    const cart: Cart = { lines: [{ ...thaliLine, quantity: 2 }], note: "Pack separately", checkoutKey: "0f6c2d1e-4a3b-4c5d-8e9f-a0b1c2d3e4f5" };
    expect(parseCart(serializeCart(cart))).toEqual(cart);
  });

  it("drops malformed or tampered lines instead of failing", () => {
    const raw = JSON.stringify({
      v: 1,
      lines: [
        thaliLine,
        { ...thaliLine },
        { itemId: "x", variantId: null, addonIds: [], quantity: 0 },
        { itemId: "x", variantId: null, addonIds: [], quantity: MAX_LINE_QUANTITY + 1 },
        { itemId: "<script>", variantId: null, addonIds: [], quantity: 1 },
        { itemId: "y", variantId: 5, addonIds: [], quantity: 1 },
        null,
      ],
      checkoutKey: "short",
    });
    const cart = parseCart(raw);
    expect(cart.lines).toEqual([thaliLine]);
    expect(cart.checkoutKey).toBeNull();
  });

  it("keeps at most the maximum number of lines", () => {
    const lines = Array.from({ length: MAX_ORDER_LINES + 5 }, (_, index) => ({ ...thaliLine, itemId: `itm_${index}` }));
    expect(parseCart(JSON.stringify({ v: 1, lines })).lines).toHaveLength(MAX_ORDER_LINES);
  });

  it("ignores other versions", () => {
    expect(parseCart(JSON.stringify({ v: 2, lines: [thaliLine] }))).toEqual(EMPTY_CART);
  });
});

describe("priceCart and reviewCheckout", () => {
  const charges = {
    minimumOrderPaise: 20_000,
    deliveryFeePaise: 3_000,
    taxEnabled: true,
    taxRateBps: 500,
    serviceAreas: ["Wadi"],
    fulfilments: ["takeaway", "delivery"] as const,
  };
  const details = { ...EMPTY_DETAILS, name: "Ravi", phone: "98450 12345", fulfilment: "takeaway" as const };

  it("prices with the same rules as the server", () => {
    const cart = cartReducer(EMPTY_CART, {
      type: "add",
      line: { itemId: biriyani.id, variantId: "var_full", addonIds: ["add_egg"], quantity: 2 },
    });
    const priced = priceCart(cart, menu);
    expect(priced.subtotalPaise).toBe(23_000);
    expect(priced.lines[0].label).toBe("Chicken Biriyani · Full · Egg");
    const review = reviewCheckout(priced, details, { ...charges, fulfilments: [...charges.fulfilments] });
    expect(review.blocker).toBeNull();
    expect(review.totals?.totalPaise).toBe(24_150);
  });

  it("flags a dish that left the menu and blocks checkout until it is removed", () => {
    const cart = cartReducer(EMPTY_CART, { type: "add", line: { ...thaliLine, itemId: "itm_gone" } });
    const priced = priceCart(cart, menu);
    expect(priced.hasUnavailable).toBe(true);
    expect(priced.lines[0].unitPricePaise).toBeNull();
    expect(reviewCheckout(priced, details, { ...charges, fulfilments: [...charges.fulfilments] }).blocker).toMatch(/no longer available/);
  });

  it("enforces the delivery minimum and area before sending", () => {
    const cart = cartReducer(EMPTY_CART, { type: "add", line: thaliLine });
    const priced = priceCart(cart, menu);
    const delivery = { ...details, fulfilment: "delivery" as const, address: "Near Kismat Talkies", serviceArea: "" };
    const all = { ...charges, fulfilments: [...charges.fulfilments] };
    expect(reviewCheckout(priced, delivery, all).blocker).toMatch(/delivery area/);
    expect(reviewCheckout(priced, { ...delivery, serviceArea: "Wadi" }, all).blocker).toMatch(/minimum/);
    // Takeaway has no minimum.
    expect(reviewCheckout(priced, details, all).blocker).toBeNull();
  });

  it("ignores a remembered fulfilment the restaurant no longer offers", () => {
    const priced = priceCart(cartReducer(EMPTY_CART, { type: "add", line: thaliLine }), menu);
    const review = reviewCheckout(priced, { ...details, fulfilment: "delivery" }, { ...charges, fulfilments: ["takeaway"] });
    expect(review.fulfilment).toBe("takeaway");
  });

  it("rejects a phone number the restaurant could not call", () => {
    const priced = priceCart(cartReducer(EMPTY_CART, { type: "add", line: thaliLine }), menu);
    const all = { ...charges, fulfilments: [...charges.fulfilments] };
    expect(reviewCheckout(priced, { ...details, phone: "12345" }, all).blocker).toMatch(/phone/);
  });
});

describe("stored details and recent orders", () => {
  it("drops an unknown fulfilment and over-long fields", () => {
    const parsed = parseDetails(JSON.stringify({ v: 1, name: "x".repeat(500), fulfilment: "drone" }));
    expect(parsed.name).toHaveLength(80);
    expect(parsed.fulfilment).toBeNull();
  });

  it("keeps the newest orders first without duplicates", () => {
    const order = (n: number) => ({
      id: `ord_${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`,
      slug: "jagadamba",
      restaurantName: "Jagadamba",
      orderNumber: n,
      placedAt: "2025-06-02T06:30:00.000Z",
    });
    let orders = rememberOrder([], order(1));
    orders = rememberOrder(orders, order(2));
    orders = rememberOrder(orders, order(1));
    expect(orders.map((entry) => entry.orderNumber)).toEqual([1, 2]);
    expect(parseRecentOrders(JSON.stringify({ v: 1, orders: [...orders, { id: "../../admin" }] }))).toEqual(orders);
  });
});

describe("checkoutFlowReducer", () => {
  it("ignores a second submit while one is in flight", () => {
    const submitting = checkoutFlowReducer({ status: "editing" }, { type: "submit" });
    expect(checkoutFlowReducer(submitting, { type: "submit" })).toBe(submitting);
  });

  it("clears a failure once the customer edits, but not mid-submit", () => {
    const failed = checkoutFlowReducer({ status: "submitting" }, { type: "fail", message: "Offline" });
    expect(checkoutFlowReducer(failed, { type: "edit" })).toEqual({ status: "editing" });
    expect(checkoutFlowReducer({ status: "submitting" }, { type: "edit" })).toEqual({ status: "submitting" });
  });
});
