import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { hasTestDatabase, resetTestDatabase, startTestDatabase, stopTestDatabase } from "./support/testDb";
import { NextRequest } from "next/server";
import { GET, POST } from "@/app/api/webroutes/[...slug]/route";
import {
  cancelDemoOrder,
  createDemoOrder,
  createNotification,
  createValidatedReservation,
  createValidatedReview,
  DELIVERY_SLOTS,
  DEMO_PAYMENT_METHODS,
  dishAllergenStatus,
  EMPTY_HANDLING,
  filterDishesByAllergens,
  portionSummary,
  restoreAvailability,
  restoreNotifications,
  restoreOrderHistory,
  restoreReservationHistory,
  restoreSessionState,
  serializeSessionState,
  toggleDishAvailability,
  validateCheckout,
} from "@/lib/checkout";
import {
  BRAND_THEME_PRESETS,
  REA_EVIDENCE_SUMMARY,
  RESTAURANTS_DATA,
  SAVED_ADDRESSES,
} from "@/data/zomatoReconstructedData";
import {
  addOrIncrementCartItem,
  calculateCartQuote,
  calculateDiningPayBill,
  filterAndSortRestaurants,
  findDishAcrossRestaurants,
  updateCartLineQuantity,
} from "@/lib/cartEngine";

// The marketplace engines are tested on the legacy fictional catalog, which the app no longer ships.
vi.mock("@/data/zomatoReconstructedData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/zomatoReconstructedData")>()),
  ...(await import("./support/legacyCatalog")).LEGACY_CATALOG,
}));

const checkout = {
  items: [{ itemId: "ctl_820099425", quantity: 1, optionIds: ["opt_500g"], unitPrice: 1 }],
  addressId: "addr_cp_514", paymentMethod: DEMO_PAYMENT_METHODS[0],
  couponCode: "KRAVE50", isGoldMember: true, riderTip: 20,
};

describe("KRAVE — REA Reconstructed Engine", () => {
  it("keeps web evidence separate from unavailable Android analysis", () => {
    expect(REA_EVIDENCE_SUMMARY.webCapture.evidenceId).toMatch(/^ev_[a-f0-9]{64}$/);
    expect(REA_EVIDENCE_SUMMARY.jsAppGraph.evidenceId).toMatch(/^ev_[a-f0-9]{64}$/);
    expect(REA_EVIDENCE_SUMMARY.jsAppGraph.visitedAstNodes).toBe(155680);
    expect(REA_EVIDENCE_SUMMARY.androidApkGraph.status).toBe("not-analyzed");
    expect(REA_EVIDENCE_SUMMARY.androidApkGraph.packageName).toBe(
      "com.application.zomato"
    );
    expect(BRAND_THEME_PRESETS.length).toBeGreaterThanOrEqual(4);
  });

  it("filters and sorts restaurants by mode, pureVeg, rating, and dish query", () => {
    const pureVeg = filterAndSortRestaurants(RESTAURANTS_DATA, {
      mode: "delivery",
      pureVegOnly: true,
    });
    expect(pureVeg.length).toBeGreaterThan(0);
    expect(pureVeg.every((r) => r.pureVeg)).toBe(true);

    const sushiSearch = filterAndSortRestaurants(RESTAURANTS_DATA, {
      mode: "delivery",
      query: "Aburi Salmon",
    });
    expect(sushiSearch.map((r) => r.slug)).toContain(
      "kumo-japanese-pan-asian-connaught-place"
    );
  });

  it("adds items with modifiers, updates quantities, and calculates ZPayKit cart quotes", () => {
    const haldirams = RESTAURANTS_DATA[0];
    const sweetBox = haldirams.menus[0].categories[0].items[0];
    const opt900g = haldirams.modifierGroups.mod_sweet_weight.options[1];

    let cart = addOrIncrementCartItem([], haldirams, sweetBox, 1, [opt900g]);
    expect(cart).toHaveLength(1);
    expect(cart[0].unitPrice).toBe(sweetBox.price + opt900g.price);

    cart = addOrIncrementCartItem(cart, haldirams, sweetBox, 1, [opt900g]);
    expect(cart[0].quantity).toBe(2);

    const quote = calculateCartQuote(cart, {
      couponCode: "KRAVE50",
      isGoldMember: true,
      riderTip: 30,
    });
    expect(quote.itemCount).toBe(2);
    expect(quote.couponDiscount).toBe(175);
    expect(quote.deliveryFee).toBe(0);
    expect(quote.goldDiscount).toBeGreaterThan(0);
    expect(quote.grandTotal).toBeGreaterThan(0);

    cart = updateCartLineQuantity(cart, cart[0].lineItemId, 0);
    expect(cart).toHaveLength(0);
  });

  it("calculates DiningPay walk-in discounts with extra Luxe membership benefit", () => {
    const otb = RESTAURANTS_DATA[1];
    const bill = calculateDiningPayBill(3000, otb, true);
    expect(bill.baseDiscount).toBe(600);
    expect(bill.goldExtraDiscount).toBe(240);
    expect(bill.totalSaved).toBe(840);
    expect(bill.finalPayable).toBe(3000 - 840 + 15);
  });

  it("rejects invalid quantities, mixed restaurants, and non-finite quotes", () => {
    const restaurant = RESTAURANTS_DATA[0];
    const dish = restaurant.menus[0].categories[0].items[0];
    const cart = addOrIncrementCartItem([], restaurant, dish, 1);
    for (const quantity of [-1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => addOrIncrementCartItem([], restaurant, dish, quantity)).toThrow();
    }
    expect(() => updateCartLineQuantity(cart, cart[0].lineItemId, -1)).toThrow();
    expect(() => calculateCartQuote(cart, { riderTip: Infinity })).toThrow();
    expect(() => calculateCartQuote(cart, { riderTip: Number.MAX_SAFE_INTEGER })).toThrow();
    expect(() => calculateCartQuote([{ ...cart[0], unitPrice: NaN }])).toThrow();
    expect(() => calculateCartQuote([cart[0], { ...cart[0], resId: -1 }])).toThrow();
    expect(() => calculateCartQuote([{ ...cart[0], quantity: Number.MAX_SAFE_INTEGER }])).toThrow();
  });

  it("locates dishes across partner restaurants for krave_webmcp tools", () => {
    const found = findDishAcrossRestaurants("ctl_dal_bukhara");
    expect(found).not.toBeNull();
    expect(found?.restaurant.name).toContain("Frontier Ember");
  });

  it("rebuilds checkout totals from catalog prices and creates explicitly demo orders", () => {
    const result = validateCheckout(checkout);
    expect(result.quote.itemTotal).toBe(732);
    const order = createDemoOrder(checkout);
    expect(order.zpaykitTransactionId).toBe("demo-no-payment-collected");
    expect(restoreOrderHistory(JSON.stringify([order]))[0].orderId).toBe(order.orderId);
    expect(restoreOrderHistory("not-json")).toEqual([]);
    expect(restoreOrderHistory('[{"orderId":"fake"}]')).toEqual([]);
  });

  it("rejects empty, malformed, and incomplete checkout requests", () => {
    for (const body of [null, {}, { ...checkout, items: [] }, { ...checkout, addressId: "unknown" },
      { ...checkout, paymentMethod: "real-charge" }, { ...checkout, riderTip: NaN },
      { ...checkout, items: [{ ...checkout.items[0], optionIds: [] }] },
      { ...checkout, items: [{ ...checkout.items[0], optionIds: ["unknown"] }] },
      { ...checkout, couponCode: "FAKE" }]) {
      expect(() => validateCheckout(body)).toThrow();
    }
  });

  it("rejects malformed JSON and invalid cart bodies at the route boundary", async () => {
    for (const body of ["not-json", "null", '{"items":[]}']) {
      const request = new NextRequest("http://localhost/api/webroutes/order/makeOrder", { method: "POST", body });
      const response = await POST(request, { params: Promise.resolve({ slug: ["order", "makeOrder"] }) });
      expect(response.status).toBe(400);
      expect((await response.json()).status).toBe("error");
    }
  });

  it("does not claim success for unimplemented routes", async () => {
    const response = await GET(new NextRequest("http://localhost/api/webroutes/unknown"), {
      params: Promise.resolve({ slug: ["unknown"] }),
    });
    expect(response.status).toBe(404);
  });

  it("validates table reservations and review submissions at the API and domain boundaries", async () => {
    const booking = createValidatedReservation({
      resId: 19677790,
      date: "Today, Oct 22",
      timeSlot: "07:30 PM",
      guests: 4,
      guestName: "Rohit Mengji",
      guestPhone: "+91 98765 43210",
      specialRequest: "Quiet table",
      isGoldMember: true,
      membershipName: "KRAVE LUXE",
    });
    expect(booking.bookingId).toMatch(/^TBL-/);
    expect(restoreReservationHistory(JSON.stringify([booking]))).toHaveLength(1);
    expect(() =>
      createValidatedReservation({
        resId: 19677790,
        date: "Today",
        timeSlot: "03:15 AM",
        guests: 2,
        guestName: "Rohit",
        guestPhone: "+91 98765 43210",
      })
    ).toThrow();

    const review = createValidatedReview({
      resId: 19677790,
      rating: 5,
      comment: "Crispy packaging and fresh mithai!",
      userName: "Rohit Mengji",
    });
    expect(review.rating).toBe(5);

    // The badge is a claim about history, so it must not be grantable by the submitter.
    expect(review.verifiedPurchase).toBe(false);
    expect(review.positiveTags).toEqual([]);
    expect(
      createValidatedReview(
        { resId: 19677790, rating: 5, comment: "Great thali", verifiedPurchase: true },
        { verifiedPurchase: false }
      ).verifiedPurchase
    ).toBe(false);
    expect(
      createValidatedReview(
        { resId: 19677790, rating: 5, comment: "Great thali" },
        { verifiedPurchase: true }
      ).positiveTags
    ).toEqual(["Verified Order"]);
    expect(() =>
      createValidatedReview({
        resId: 19677790,
        rating: 5,
        comment: "bad",
      })
    ).toThrow();

    const bookingReq = new NextRequest("http://localhost/api/webroutes/user/booking", {
      method: "POST",
      body: JSON.stringify({
        resId: 19677790,
        date: "Today, Oct 22",
        timeSlot: "07:30 PM",
        guests: 2,
        guestName: "Rohit Mengji",
        guestPhone: "+91 98765 43210",
      }),
      headers: { "Content-Type": "application/json" },
    });
    const bookingRes = await POST(bookingReq, {
      params: Promise.resolve({ slug: ["user", "booking"] }),
    });
    expect(bookingRes.status).toBe(201);
  });

  it("restores a saved browsing session and drops items the catalog no longer has", () => {
    const restaurant = RESTAURANTS_DATA[0];
    const dish = restaurant.menus[0].categories[0].items[0];
    const cartItems = addOrIncrementCartItem([], restaurant, dish, 2, []);

    const saved = serializeSessionState({
      cartItems,
      addressId: SAVED_ADDRESSES[1].id,
      themeId: BRAND_THEME_PRESETS[1].id,
      isDark: false,
      mode: "dineout",
      isGoldMember: false,
      couponCode: "KRAVE50",
      riderTip: 40,
      handling: EMPTY_HANDLING,
      scheduledSlot: DELIVERY_SLOTS[0],
    });

    // Prices are never trusted from storage; they are rebuilt from the catalog.
    expect(saved).not.toContain("unitPrice");

    const restored = restoreSessionState(saved)!;
    expect(restored.cartItems).toHaveLength(1);
    expect(restored.cartItems[0].quantity).toBe(2);
    expect(restored.cartItems[0].unitPrice).toBe(cartItems[0].unitPrice);
    expect(restored.addressId).toBe(SAVED_ADDRESSES[1].id);
    expect(restored.themeId).toBe(BRAND_THEME_PRESETS[1].id);
    expect(restored.isDark).toBe(false);
    expect(restored.mode).toBe("dineout");
    expect(restored.isGoldMember).toBe(false);
    expect(restored.couponCode).toBe("KRAVE50");
    expect(restored.riderTip).toBe(40);

    const tampered = restoreSessionState(
      JSON.stringify({
        items: [
          { itemId: "does_not_exist", quantity: 3, optionIds: [] },
          { itemId: dish.id, quantity: 1, optionIds: [] },
        ],
        addressId: "missing",
        themeId: "missing",
        mode: "spaceship",
        couponCode: "NOT_A_COUPON",
        riderTip: 999999,
      })
    )!;
    expect(tampered.cartItems).toHaveLength(1);
    expect(tampered.addressId).toBe(SAVED_ADDRESSES[0].id);
    expect(tampered.themeId).toBe(BRAND_THEME_PRESETS[0].id);
    expect(tampered.mode).toBe("delivery");
    expect(tampered.couponCode).toBeNull();
    expect(tampered.riderTip).toBe(500);

    expect(restoreSessionState(null)).toBeNull();
    expect(restoreSessionState("not-json")).toBeNull();
    expect(restoreSessionState("[]")).toBeNull();
  });

  it("keeps a declared allergy attached to the cart it was declared for", () => {
    const restaurant = RESTAURANTS_DATA[0];
    const dish = restaurant.menus[0].categories[0].items[0];
    const cartItems = addOrIncrementCartItem([], restaurant, dish, 1, []);

    const saved = serializeSessionState({
      cartItems,
      addressId: SAVED_ADDRESSES[0].id,
      themeId: BRAND_THEME_PRESETS[0].id,
      isDark: true,
      mode: "delivery",
      isGoldMember: false,
      couponCode: null,
      riderTip: 0,
      handling: { flags: ["ALLERGY", "NO_CUTLERY"], allergyNote: "severe peanut allergy" },
      scheduledSlot: "Tomorrow, 12:30 PM",
    });

    // The cart surviving a refresh while its allergy quietly does not is the dangerous
    // asymmetry: an absent warning is far harder to notice than a present one.
    const restored = restoreSessionState(saved)!;
    expect(restored.cartItems).toHaveLength(1);
    expect(restored.handling.flags).toEqual(["ALLERGY", "NO_CUTLERY"]);
    expect(restored.handling.allergyNote).toBe("severe peanut allergy");
    expect(restored.scheduledSlot).toBe("Tomorrow, 12:30 PM");
  });

  it("re-validates stored handling instead of trusting the browser", () => {
    const base = {
      items: [],
      addressId: SAVED_ADDRESSES[0].id,
      themeId: BRAND_THEME_PRESETS[0].id,
    };

    // An allergy with no trigger is not a usable warning, so it is dropped rather than
    // shown to the kitchen as if it were one.
    const hollow = restoreSessionState(
      JSON.stringify({ ...base, handling: { flags: ["ALLERGY"], allergyNote: "" } })
    )!;
    expect(hollow.handling).toEqual(EMPTY_HANDLING);

    const unknownFlag = restoreSessionState(
      JSON.stringify({ ...base, handling: { flags: ["DELIVER_BY_DRONE"] } })
    )!;
    expect(unknownFlag.handling).toEqual(EMPTY_HANDLING);

    const badSlot = restoreSessionState(JSON.stringify({ ...base, scheduledSlot: "Next year" }))!;
    expect(badSlot.scheduledSlot).toBe(DELIVERY_SLOTS[0]);
  });

  it("never reports an undeclared dish as free of an allergen", () => {
    const declaredClear = { allergens: ["DAIRY"] };
    const declaredContains = { allergens: ["PEANUT", "DAIRY"] };
    const undeclared: { allergens?: string[] } = {};
    const declaredEmpty = { allergens: [] as string[] };

    // The whole point: silence from a kitchen is not a statement of safety.
    expect(dishAllergenStatus(undeclared.allergens, ["PEANUT"])).toBe("UNDECLARED");
    expect(dishAllergenStatus(undefined, ["PEANUT"])).toBe("UNDECLARED");
    expect(dishAllergenStatus(declaredContains.allergens, ["PEANUT"])).toBe("CONTAINS");
    expect(dishAllergenStatus(declaredClear.allergens, ["PEANUT"])).toBe("CLEAR");
    // An explicit empty declaration is a statement, unlike an absent one.
    expect(dishAllergenStatus(declaredEmpty.allergens, ["PEANUT"])).toBe("CLEAR");

    // Avoiding nothing still distinguishes declared from undeclared.
    expect(dishAllergenStatus(undefined, [])).toBe("UNDECLARED");
    expect(dishAllergenStatus(declaredClear.allergens, [])).toBe("CLEAR");
  });

  it("keeps undeclared dishes out of the safe bucket entirely", () => {
    const dishes = [
      { id: "a", allergens: ["DAIRY"] },
      { id: "b", allergens: ["PEANUT"] },
      { id: "c" },
      { id: "d", allergens: [] as string[] },
    ];

    const { safe, contains, undeclared } = filterDishesByAllergens(dishes, ["PEANUT"]);
    expect(safe.map((dish) => dish.id)).toEqual(["a", "d"]);
    expect(contains.map((dish) => dish.id)).toEqual(["b"]);
    expect(undeclared.map((dish) => dish.id)).toEqual(["c"]);

    // Every dish is accounted for, so none can quietly vanish from the menu.
    expect(safe.length + contains.length + undeclared.length).toBe(dishes.length);
  });

  it("treats any one avoided allergen as disqualifying", () => {
    const dish = { allergens: ["DAIRY", "GLUTEN"] };
    expect(dishAllergenStatus(dish.allergens, ["PEANUT", "GLUTEN"])).toBe("CONTAINS");
    expect(dishAllergenStatus(dish.allergens, ["PEANUT", "SOY"])).toBe("CLEAR");
  });

  it("says when a portion is undeclared rather than leaving it blank", () => {
    expect(portionSummary(500, undefined).declared).toBe(false);
    expect(portionSummary(500, undefined).label).toMatch(/not declared/i);
    expect(portionSummary(500, {}).pricePerHundredGrams).toBeNull();

    // A zero or negative weight is not a declaration either, and must not divide.
    expect(portionSummary(500, { grams: 0 }).declared).toBe(false);
    expect(portionSummary(500, { grams: -200 }).pricePerHundredGrams).toBeNull();

    const declared = portionSummary(732, { grams: 900 });
    expect(declared.declared).toBe(true);
    expect(declared.pricePerHundredGrams).toBe(81);
    expect(Number.isFinite(declared.pricePerHundredGrams!)).toBe(true);

    expect(portionSummary(215, { grams: 280, serves: 1 }).label).toBe("280g · serves 1");
    expect(portionSummary(215, { serves: 3 }).label).toBe("serves 3");
    expect(portionSummary(215, { serves: 3 }).pricePerHundredGrams).toBeNull();
  });

  it("cancels a demo order only before the kitchen starts it", () => {
    const order = createDemoOrder(checkout);

    expect(cancelDemoOrder([order], order.orderId)).toHaveLength(0);
    expect(() => cancelDemoOrder([order], "KRV-unknown")).toThrow();
    expect(() =>
      cancelDemoOrder([{ ...order, stage: "KITCHEN_PREPARING" }], order.orderId)
    ).toThrow();
  });

  // Both sign-out routes take no payload. Requiring JSON here has silently broken
  // sign-out twice, so the bodyless call is asserted rather than assumed.
  it.each(["logout", "logout-everywhere"])(
    "handles POST /webroutes/auth/%s with no request body",
    async (action) => {
      const response = await POST(
        new NextRequest(`http://localhost/api/webroutes/auth/${action}`, { method: "POST" }),
        { params: Promise.resolve({ slug: ["auth", action] }) }
      );
      const result = await response.json();

      expect(result.message).not.toBe("Invalid JSON request.");
      // Signed out it is a success; signed in it needs a session, never a parse failure.
      expect([200, 401]).toContain(response.status);
    }
  );

  it("accepts only published delivery windows and keeps the choice on the order", () => {
    expect(createDemoOrder(checkout).scheduledSlot).toBe(DELIVERY_SLOTS[0]);

    const scheduled = createDemoOrder({ ...checkout, scheduledSlot: "Tomorrow, 12:30 PM" });
    expect(scheduled.scheduledSlot).toBe("Tomorrow, 12:30 PM");
    expect(restoreOrderHistory(JSON.stringify([scheduled]))[0].scheduledSlot).toBe(
      "Tomorrow, 12:30 PM"
    );

    expect(() => validateCheckout({ ...checkout, scheduledSlot: "Next year" })).toThrow();
    expect(() => validateCheckout({ ...checkout, scheduledSlot: 5 })).toThrow();
  });

  it("keeps the 86 list to dishes that exist on a menu", () => {
    const dishId = RESTAURANTS_DATA[0].menus[0].categories[0].items[0].id;

    const marked = toggleDishAvailability([], dishId);
    expect(marked).toEqual([dishId]);
    expect(toggleDishAvailability(marked, dishId)).toEqual([]);
    expect(() => toggleDishAvailability([], "not_a_dish")).toThrow();

    expect(restoreAvailability(JSON.stringify([dishId, dishId, "ghost"]))).toEqual([dishId]);
    expect(restoreAvailability("not-json")).toEqual([]);
    expect(restoreAvailability(JSON.stringify({}))).toEqual([]);
  });

  it("restores the local notification inbox and discards malformed entries", () => {
    const entry = createNotification("ORDER", "Demo order confirmed", "No payment was collected.");
    expect(entry.read).toBe(false);
    expect(entry.id).toMatch(/^ntf_/);

    const restored = restoreNotifications(JSON.stringify([entry, { id: "bad" }, null]));
    expect(restored).toHaveLength(1);
    expect(restored[0].title).toBe("Demo order confirmed");

    expect(restoreNotifications(JSON.stringify([{ ...entry, kind: "SPAM" }]))).toEqual([]);
    expect(restoreNotifications("not-json")).toEqual([]);
    expect(restoreNotifications(null)).toEqual([]);
  });
});

// The route reads live sell-outs from Postgres, so the happy path needs the test branch.
describe.skipIf(!hasTestDatabase)("checkout route against Postgres", () => {
  beforeAll(startTestDatabase);
  beforeEach(resetTestDatabase);
  afterAll(stopTestDatabase);

  it("returns a validated demo confirmation from the checkout route", async () => {
    const request = new NextRequest("http://localhost/api/webroutes/order/makeOrder", {
      method: "POST", body: JSON.stringify(checkout), headers: { "Content-Type": "application/json" },
    });
    const response = await POST(request, { params: Promise.resolve({ slug: ["order", "makeOrder"] }) });
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(result.demo).toBe(true);
    expect(result.order.quote.itemTotal).toBe(732);
  });
});
