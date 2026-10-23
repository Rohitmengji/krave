import { describe, expect, it } from "vitest";
import {
  createDemoOrder,
  createNotification,
  createValidatedReservation,
  createValidatedReview,
  DEMO_PAYMENT_METHODS,
  EMPTY_HANDLING,
  DELIVERY_SLOTS,
  MAX_RIDER_TIP,
  restoreOrderHistory,
  restoreSessionState,
  validateCheckout,
} from "@/lib/checkout";
import {
  applyModifierToggle,
  CART_LIMITS,
  cartLimitViolation,
  couponIneligibility,
  defaultModifierSelection,
  modifierSelectionProblem,
} from "@/lib/cartEngine";
import { customiserProblem, customiserReducer, type CustomiserState } from "@/lib/dishCustomiser";
import { COUPON_OFFERS, RESTAURANTS_DATA } from "@/data/zomatoReconstructedData";
import type { DishItem, ModifierGroup } from "@/types/krave";

// A ₹732 sweets box with one required single-choice group (default "opt_500g").
const SWEETS = "ctl_820099425";

function checkout(overrides: Record<string, unknown> = {}) {
  return {
    items: [{ itemId: SWEETS, quantity: 2, optionIds: ["opt_500g"] }],
    addressId: "addr_cp_514",
    paymentMethod: DEMO_PAYMENT_METHODS[0],
    couponCode: null,
    isGoldMember: false,
    riderTip: 0,
    ...overrides,
  };
}

describe("placement limits", () => {
  it("refuses an oversized line, even when built from repeated entries", () => {
    const tooMany = checkout({
      items: [{ itemId: SWEETS, quantity: CART_LIMITS.maxLineQuantity + 1, optionIds: ["opt_500g"] }],
    });
    expect(() => validateCheckout(tooMany)).toThrow(/up to 50/);

    const split = checkout({
      items: [
        { itemId: SWEETS, quantity: 30, optionIds: ["opt_500g"] },
        { itemId: SWEETS, quantity: 30, optionIds: ["opt_500g"] },
      ],
    });
    expect(() => validateCheckout(split)).toThrow(/up to 50/);

    const atLimit = checkout({
      items: [{ itemId: SWEETS, quantity: CART_LIMITS.maxLineQuantity, optionIds: ["opt_500g"] }],
    });
    expect(validateCheckout(atLimit).items[0].quantity).toBe(50);
  });

  it("bounds the request before looking anything up", () => {
    const flood = checkout({
      items: Array.from({ length: CART_LIMITS.maxLines + 1 }, () => ({
        itemId: SWEETS,
        quantity: 1,
        optionIds: ["opt_500g"],
      })),
    });
    expect(() => validateCheckout(flood)).toThrow(/30 different dishes/);
  });

  it("caps the rider tip and the cooking note", () => {
    expect(() => validateCheckout(checkout({ riderTip: MAX_RIDER_TIP + 1 }))).toThrow(/capped/);
    expect(validateCheckout(checkout({ riderTip: MAX_RIDER_TIP })).quote.riderTip).toBe(500);

    const longNote = checkout({
      items: [{ itemId: SWEETS, quantity: 1, optionIds: ["opt_500g"], cookingInstruction: "x".repeat(201) }],
    });
    expect(() => validateCheckout(longNote)).toThrow(/200 characters/);
  });

  it("never drops an order already on record because a limit was tightened later", () => {
    const legacy = checkout({
      items: [{ itemId: SWEETS, quantity: 80, optionIds: ["opt_500g"], cookingInstruction: "y".repeat(400) }],
      riderTip: 2000,
    });
    expect(() => validateCheckout(legacy)).toThrow();
    const order = createDemoOrder(legacy);
    const [restored] = restoreOrderHistory(JSON.stringify([order]));
    expect(restored?.orderId).toBe(order.orderId);
    expect(restored.items[0].quantity).toBe(80);
  });

  it("explains which rule a cart breaks", () => {
    const [line] = validateCheckout(checkout()).items;
    expect(cartLimitViolation([line])).toBeNull();
    expect(cartLimitViolation([{ ...line, quantity: 51 }])).toMatch(/Ghee Assorted Sweets Box/);
    expect(cartLimitViolation([line], 501)).toMatch(/₹500/);
  });
});

describe("coupon eligibility", () => {
  it("keeps GOLDVIP for members", () => {
    const big = { items: [{ itemId: SWEETS, quantity: 2, optionIds: ["opt_500g"] }], couponCode: "GOLDVIP" };
    expect(() => validateCheckout(checkout(big))).toThrow(/members-only/);
    expect(validateCheckout(checkout({ ...big, isGoldMember: true })).quote.couponCode).toBe("GOLDVIP");
  });

  it("binds KRAVECARD to card payment", () => {
    expect(() => validateCheckout(checkout({ couponCode: "KRAVECARD" }))).toThrow(/Card \(demo\)/);
    const card = validateCheckout(checkout({ couponCode: "KRAVECARD", paymentMethod: "Card (demo)" }));
    expect(card.quote.couponDiscount).toBeGreaterThan(0);
  });

  it("applies the welcome offer only to a first order, and only when history is known", () => {
    const welcome = checkout({ couponCode: "KRAVE50" });
    expect(validateCheckout(welcome).quote.couponCode).toBe("KRAVE50");
    expect(validateCheckout(welcome, { hasOrderedBefore: false }).quote.couponCode).toBe("KRAVE50");
    expect(() => validateCheckout(welcome, { hasOrderedBefore: true })).toThrow(/first order/);
  });

  it("does not judge a payment-bound offer before a method is chosen", () => {
    expect(couponIneligibility("KRAVECARD", { isGoldMember: false })).toBeNull();
    expect(couponIneligibility(" kravecard ", { isGoldMember: false, paymentMethod: "UPI (demo)" }))
      .toMatch(/KRAVECARD/);
    expect(couponIneligibility(null, { isGoldMember: false })).toBeNull();
    expect(couponIneligibility("NOT_A_CODE", { isGoldMember: false })).toBeNull();
  });

  it("only names payment methods that exist", () => {
    for (const offer of COUPON_OFFERS) {
      if (offer.requiresPaymentMethod) {
        expect(DEMO_PAYMENT_METHODS).toContain(offer.requiresPaymentMethod);
      }
    }
  });

  it("replays an order placed before the rules existed", () => {
    const legacy = checkout({ couponCode: "GOLDVIP" });
    const order = createDemoOrder(legacy);
    expect(restoreOrderHistory(JSON.stringify([order]))).toHaveLength(1);
  });
});

const group = (overrides: Partial<ModifierGroup>): ModifierGroup => ({
  id: "g",
  title: "Sides",
  subtitle: "",
  required: false,
  minSelect: 0,
  maxSelect: 1,
  options: [
    { id: "a", name: "A", price: 0, dietary: "veg" },
    { id: "b", name: "B", price: 20, dietary: "veg" },
    { id: "c", name: "C", price: 30, dietary: "veg" },
  ],
  ...overrides,
});

describe("modifier rules shared by the customiser, quick-add and the server", () => {
  it("swaps a single choice and never empties a required one", () => {
    const required = group({ required: true, minSelect: 1 });
    const [a, b] = required.options;
    expect(applyModifierToggle(required, [a], b)).toEqual([b]);
    const same = [a];
    expect(applyModifierToggle(required, same, a)).toBe(same);
  });

  it("lets an optional single choice be cleared", () => {
    const optional = group({});
    const [a] = optional.options;
    expect(applyModifierToggle(optional, [a], a)).toEqual([]);
  });

  it("stops a multi-choice at its maximum and ignores foreign options", () => {
    const multi = group({ maxSelect: 2 });
    const [a, b, c] = multi.options;
    const two = applyModifierToggle(multi, applyModifierToggle(multi, [], a), b);
    expect(two).toEqual([a, b]);
    expect(applyModifierToggle(multi, two, c)).toBe(two);
    const foreign = { id: "z", name: "Z", price: 0, dietary: "veg" as const };
    expect(applyModifierToggle(multi, two, foreign)).toBe(two);
  });

  it("starts from defaults topped up to each group's minimum", () => {
    const pickTwo = group({ required: true, minSelect: 2, maxSelect: 3 });
    expect(defaultModifierSelection([pickTwo]).map((option) => option.id)).toEqual(["a", "b"]);
    const withDefault = group({
      required: true,
      minSelect: 1,
      options: [
        { id: "a", name: "A", price: 0, dietary: "veg" },
        { id: "b", name: "B", price: 0, dietary: "veg", isDefault: true },
      ],
    });
    expect(defaultModifierSelection([withDefault]).map((option) => option.id)).toEqual(["b"]);
    expect(defaultModifierSelection([group({})])).toEqual([]);
  });

  it("names the group that is short or over", () => {
    const pickTwo = group({ title: "Dips", minSelect: 2, maxSelect: 2 });
    expect(modifierSelectionProblem([pickTwo], new Set(["a"]))).toBe("Choose at least 2 for Dips.");
    expect(modifierSelectionProblem([pickTwo], new Set(["a", "b", "c"]))).toBe("Choose up to 2 for Dips.");
    expect(modifierSelectionProblem([pickTwo], new Set(["a", "b"]))).toBeNull();
  });

  it("gives the server the same message the customiser shows", () => {
    const missing = checkout({ items: [{ itemId: SWEETS, quantity: 1, optionIds: [] }] });
    expect(() => validateCheckout(missing)).toThrow("Choose an option for Select Gift Box Weight.");
  });
});

describe("dish customiser reducer", () => {
  const restaurant = RESTAURANTS_DATA[0];
  const dish = { ...restaurant.menus[0].categories[0].items[0] } as DishItem;
  const groups = [group({ required: true, minSelect: 2, maxSelect: 3, title: "Dips" })];
  const open = (): CustomiserState => customiserReducer(null, { type: "OPEN", dish, groups })!;

  it("opens with defaults, one portion and no note", () => {
    const state = open();
    expect(state.quantity).toBe(1);
    expect(state.note).toBe("");
    expect(state.options.map((option) => option.id)).toEqual(["a", "b"]);
    expect(customiserProblem(state)).toBeNull();
  });

  it("keeps quantity between one and the line cap", () => {
    let state = open();
    state = customiserReducer(state, { type: "STEP_QUANTITY", delta: -1 })!;
    expect(state.quantity).toBe(1);
    for (let step = 0; step < 80; step += 1) {
      state = customiserReducer(state, { type: "STEP_QUANTITY", delta: 1 })!;
    }
    expect(state.quantity).toBe(CART_LIMITS.maxLineQuantity);
    expect(customiserReducer(state, { type: "STEP_QUANTITY", delta: NaN })).toBe(state);
  });

  it("returns the same state when nothing changes, so React can skip the render", () => {
    const state = open();
    const [a] = groups[0].options;
    const after = customiserReducer(state, { type: "TOGGLE_OPTION", groupId: "missing", option: a });
    expect(after).toBe(state);
  });

  it("blocks adding when a toggle leaves a group short", () => {
    const state = open();
    const [a] = groups[0].options;
    const short = customiserReducer(state, { type: "TOGGLE_OPTION", groupId: "g", option: a })!;
    expect(customiserProblem(short)).toBe("Choose at least 2 for Dips.");
  });

  it("trims the note to the cap and clears on close", () => {
    const state = customiserReducer(open(), { type: "SET_NOTE", note: "n".repeat(500) })!;
    expect(state.note).toHaveLength(CART_LIMITS.maxInstructionLength);
    expect(customiserReducer(state, { type: "CLOSE" })).toBeNull();
    expect(customiserReducer(null, { type: "STEP_QUANTITY", delta: 1 })).toBeNull();
  });
});

describe("restored carts stay placeable", () => {
  it("trims quantity, line count and notes saved by an older build", () => {
    const saved = JSON.stringify({
      items: [{ itemId: SWEETS, quantity: 999, optionIds: ["opt_500g"], cookingInstruction: "z".repeat(900) }],
      handling: EMPTY_HANDLING,
      scheduledSlot: DELIVERY_SLOTS[0],
    });
    const restored = restoreSessionState(saved)!;
    expect(restored.cartItems[0].quantity).toBe(CART_LIMITS.maxLineQuantity);
    expect(restored.cartItems[0].cookingInstruction).toHaveLength(CART_LIMITS.maxInstructionLength);
    expect(cartLimitViolation(restored.cartItems)).toBeNull();
  });
});

describe("identifiers", () => {
  it("uses full-length ids where a clash would leave a partial write", () => {
    expect(createNotification("ORDER", "t", "b").id).toMatch(/^ntf_[0-9a-f-]{36}$/);
    const review = createValidatedReview({ resId: RESTAURANTS_DATA[0].resId, rating: 5, comment: "Lovely food" });
    expect(review.id).toMatch(/^rev_[0-9a-f-]{36}$/);
  });

  it("keeps the spoken booking code short but wide enough not to clash", () => {
    const restaurant = RESTAURANTS_DATA.find((candidate) => candidate.isOpen && candidate.diningSlots.length)!;
    const slot = restaurant.diningSlots.find((candidate) => candidate.seatsLeft > 0)!;
    const booking = createValidatedReservation({
      resId: restaurant.resId,
      date: "Today",
      timeSlot: slot.time,
      guests: 2,
      guestName: "Asha Rao",
      guestPhone: "+91 98111 22233",
    });
    expect(booking.bookingId).toMatch(/^TBL-[0-9A-F]{12}$/);
  });
});
