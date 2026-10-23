import { BRAND_THEME_PRESETS, COUPON_OFFERS, RESTAURANTS_DATA, SAVED_ADDRESSES } from "@/data/zomatoReconstructedData";
import {
  addOrIncrementCartItem,
  calculateCartQuote,
  CART_LIMITS,
  cartLimitViolation,
  couponIneligibility,
  findDishAcrossRestaurants,
  modifierSelectionProblem,
} from "./cartEngine";
import { newId } from "./ids";
import { atOutletClock, bookingTimeProblem } from "./outletClock";
import type {
  CartLineItem,
  CrystalOrderState,
  DiningReservation,
  DiscoveryTabKey,
  RestaurantReview,
} from "@/types/krave";

export const DEMO_PAYMENT_METHODS = ["UPI (demo)", "Card (demo)", "Pay on delivery (demo)"] as const;
export const ORDER_HISTORY_KEY = "krave.demo-orders.v1";
export const RESERVATION_HISTORY_KEY = "krave.demo-reservations.v1";
export const BOOKMARKS_STORAGE_KEY = "krave.bookmarks.v1";
export const SESSION_STATE_KEY = "krave.session.v1";
export const AVAILABILITY_KEY = "krave.availability.v1";
export const NOTIFICATIONS_KEY = "krave.notifications.v1";
export const ORDER_STAGES = ["ORDER_CONFIRMED", "KITCHEN_PREPARING", "RIDER_ASSIGNED", "OUT_FOR_DELIVERY", "ARRIVED"] as const;
export const DISCOVERY_MODES = ["delivery", "dineout", "nightlife"] as const;
export const MAX_RIDER_TIP = CART_LIMITS.maxRiderTip;

/**
 * Fixed demo windows rather than clock-derived ones, so the server and the browser always
 * agree on what was requested and the value can be validated without a shared clock.
 */
export const DELIVERY_SLOTS = [
  "ASAP",
  "In 1 hour",
  "In 2 hours",
  "Tonight, 8:00 PM",
  "Tomorrow, 12:30 PM",
] as const;

/**
 * Handling the kitchen must act on, kept structured rather than buried in free text so it
 * can be printed on a ticket and checked, instead of relying on someone reading a note.
 */
export const KITCHEN_FLAGS = [
  { id: "ALLERGY", label: "Allergy", critical: true },
  { id: "JAIN", label: "Jain — no root vegetables", critical: true },
  { id: "NO_ONION_GARLIC", label: "No onion or garlic", critical: true },
  { id: "LESS_SPICY", label: "Less spicy", critical: false },
  { id: "NO_CUTLERY", label: "No cutlery", critical: false },
] as const;

export type KitchenFlagId = (typeof KITCHEN_FLAGS)[number]["id"];

/** The allergens a kitchen can declare against a dish. */
export const ALLERGENS = [
  { id: "PEANUT", label: "Peanuts" },
  { id: "TREE_NUT", label: "Tree nuts" },
  { id: "DAIRY", label: "Dairy" },
  { id: "GLUTEN", label: "Gluten" },
  { id: "EGG", label: "Egg" },
  { id: "SOY", label: "Soy" },
  { id: "SHELLFISH", label: "Shellfish" },
  { id: "FISH", label: "Fish" },
  { id: "SESAME", label: "Sesame" },
  { id: "MUSTARD", label: "Mustard" },
] as const;

export type AllergenId = (typeof ALLERGENS)[number]["id"];

export type AllergenStatus = "CONTAINS" | "UNDECLARED" | "CLEAR";

const ALLERGEN_LABELS = new Map<string, string>(
  ALLERGENS.map((allergen) => [allergen.id as string, allergen.label])
);

/** Falls back to the raw id so an allergen added later is never silently dropped. */
export function allergenLabel(id: string): string {
  return ALLERGEN_LABELS.get(id) ?? id;
}

export function allergenLabels(ids: string[]): string {
  return ids.map(allergenLabel).join(", ");
}

/**
 * How a dish stands against the allergens someone is avoiding.
 *
 * `UNDECLARED` is deliberately its own answer rather than being folded into `CLEAR`.
 * A kitchen that has said nothing has not said "safe", and presenting silence as safety
 * is the failure mode that actually hurts people.
 */
export function dishAllergenStatus(
  declared: string[] | undefined,
  avoiding: string[]
): AllergenStatus {
  if (avoiding.length === 0) return declared ? "CLEAR" : "UNDECLARED";
  if (!declared) return "UNDECLARED";
  return declared.some((allergen) => avoiding.includes(allergen)) ? "CONTAINS" : "CLEAR";
}

/** Only dishes a kitchen has positively declared clear. Silence never qualifies. */
export function filterDishesByAllergens<T extends { allergens?: string[] }>(
  dishes: T[],
  avoiding: string[]
): { safe: T[]; contains: T[]; undeclared: T[] } {
  const safe: T[] = [];
  const contains: T[] = [];
  const undeclared: T[] = [];

  for (const dish of dishes) {
    const status = dishAllergenStatus(dish.allergens, avoiding);
    if (status === "CONTAINS") contains.push(dish);
    else if (status === "UNDECLARED") undeclared.push(dish);
    else safe.push(dish);
  }

  return { safe, contains, undeclared };
}

export interface PortionSummary {
  declared: boolean;
  label: string;
  /** Rupees per 100g, for comparing dishes honestly. Null unless weight is declared. */
  pricePerHundredGrams: number | null;
}

/**
 * How much food you are actually buying.
 *
 * An undeclared portion says so rather than being left blank, because a blank reads
 * as "normal" and a photo of a large bowl is not a declaration.
 */
export function portionSummary(
  price: number,
  portion: { grams?: number; serves?: number } | undefined
): PortionSummary {
  const grams =
    portion?.grams !== undefined && Number.isFinite(portion.grams) && portion.grams > 0
      ? portion.grams
      : null;
  const serves =
    portion?.serves !== undefined && Number.isFinite(portion.serves) && portion.serves > 0
      ? portion.serves
      : null;

  if (grams === null && serves === null) {
    return { declared: false, label: "Portion size not declared", pricePerHundredGrams: null };
  }

  const parts: string[] = [];
  if (grams !== null) parts.push(`${grams}g`);
  if (serves !== null) parts.push(serves === 1 ? "serves 1" : `serves ${serves}`);

  return {
    declared: true,
    label: parts.join(" · "),
    pricePerHundredGrams:
      grams !== null && Number.isFinite(price) && price >= 0
        ? Math.round((price / grams) * 100)
        : null,
  };
}

export interface KitchenHandling {
  flags: KitchenFlagId[];
  /** Required when ALLERGY is set: what the guest reacts to. */
  allergyNote: string;
}

export const EMPTY_HANDLING: KitchenHandling = { flags: [], allergyNote: "" };

export function isCriticalFlag(id: KitchenFlagId): boolean {
  return KITCHEN_FLAGS.some((flag) => flag.id === id && flag.critical);
}

/**
 * An allergy with no stated trigger is worse than useless: it looks handled while telling
 * the kitchen nothing, so it is rejected rather than stored as an empty note.
 */
export function validateKitchenHandling(input: unknown): KitchenHandling {
  if (input === undefined || input === null) return EMPTY_HANDLING;
  const body = record(input);

  const raw = Array.isArray(body.flags) ? body.flags : [];
  const flags = KITCHEN_FLAGS.filter((flag) => raw.includes(flag.id)).map((flag) => flag.id);
  if (raw.length !== flags.length) {
    throw new Error("That handling request is not one the kitchen recognises.");
  }

  const allergyNote = typeof body.allergyNote === "string" ? body.allergyNote.trim() : "";
  if (flags.includes("ALLERGY")) {
    if (allergyNote.length < 3) {
      throw new Error("Tell the kitchen what the allergy is so they can act on it.");
    }
    if (allergyNote.length > 200) {
      throw new Error("Keep the allergy note under 200 characters.");
    }
  }

  return { flags, allergyNote: flags.includes("ALLERGY") ? allergyNote : "" };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a checkout object.");
  }
  return value as Record<string, unknown>;
}

/**
 * Structural checks and catalog pricing only. Shared by placement and by the replay of stored
 * orders, so it must never gain a rule that an order already on record could fail.
 */
function parseCheckout(input: unknown) {
  const body = record(input);
  if (!Array.isArray(body.items) || body.items.length === 0) {
    throw new Error("Add at least one item before checkout.");
  }
  const address = SAVED_ADDRESSES.find((candidate) => candidate.id === body.addressId);
  if (!address?.o2Serviceable) throw new Error("Select a serviceable delivery address.");
  if (!DEMO_PAYMENT_METHODS.some((method) => method === body.paymentMethod)) {
    throw new Error("Select a supported demo payment method.");
  }
  if (typeof body.isGoldMember !== "boolean") throw new Error("Membership selection is required.");
  if (body.couponCode !== null && typeof body.couponCode !== "string") {
    throw new Error("Coupon code must be text or null.");
  }
  if (typeof body.riderTip !== "number") throw new Error("A valid rider tip is required.");
  const scheduledSlot =
    body.scheduledSlot === undefined || body.scheduledSlot === null
      ? DELIVERY_SLOTS[0]
      : DELIVERY_SLOTS.find((slot) => slot === body.scheduledSlot);
  if (!scheduledSlot) throw new Error("Select an available delivery time.");

  let items: CartLineItem[] = [];
  for (const entry of body.items) {
    const line = record(entry);
    if (typeof line.itemId !== "string" || typeof line.quantity !== "number" ||
        !Array.isArray(line.optionIds) || !line.optionIds.every((id) => typeof id === "string")) {
      throw new Error("Cart items require an item ID, quantity, and option IDs.");
    }
    const found = findDishAcrossRestaurants(line.itemId);
    if (!found || !found.restaurant.isOpen || !found.restaurant.modes.includes("delivery")) {
      throw new Error("One of your items is unavailable for delivery.");
    }
    if (items.length && items[0].resId !== found.restaurant.resId) {
      throw new Error("Order from one restaurant at a time.");
    }
    const groups = found.dish.modifier_group_ids.map((id) => found.restaurant.modifierGroups[id]);
    const optionIds = new Set(line.optionIds);
    const options = groups.flatMap((group) => group.options).filter((option) => optionIds.has(option.id));
    if (optionIds.size !== line.optionIds.length || options.length !== optionIds.size) {
      throw new Error("A selected dish option is invalid.");
    }
    const selectionProblem = modifierSelectionProblem(groups, optionIds);
    if (selectionProblem) throw new Error(selectionProblem);
    if (line.cookingInstruction !== undefined && typeof line.cookingInstruction !== "string") {
      throw new Error("Cooking instructions must be text.");
    }
    items = addOrIncrementCartItem(items, found.restaurant, found.dish, line.quantity, options, line.cookingInstruction);
  }
  const couponCode = typeof body.couponCode === "string" ? body.couponCode.trim().toUpperCase() : null;
  const quote = calculateCartQuote(items, { couponCode, isGoldMember: body.isGoldMember, riderTip: body.riderTip });
  if (couponCode && (!COUPON_OFFERS.some((offer) => offer.code === couponCode) || !quote.couponCode)) {
    throw new Error("This coupon is not valid for your current cart.");
  }
  const restaurant = RESTAURANTS_DATA.find((candidate) => candidate.resId === quote.resId)!;
  return {
    items,
    quote,
    address,
    restaurant,
    paymentMethod: String(body.paymentMethod),
    isGoldMember: body.isGoldMember === true,
    scheduledSlot,
    handling: validateKitchenHandling(body.handling),
  };
}

export interface PlacementContext {
  /** Known only for signed-in customers; when given, first-order offers are enforced. */
  hasOrderedBefore?: boolean;
  /** The server's clock unless a test pins it. */
  now?: Date;
}

/**
 * The gate for a new order: catalog pricing plus the rules that only apply going forward
 * (size limits, tip cap, who may use which coupon). Prices are rebuilt from the catalog,
 * never taken from client totals.
 */
export function validateCheckout(input: unknown, context: PlacementContext = {}) {
  const body = record(input);
  // Bounded before the per-line catalog lookups, so an oversized request costs nothing.
  if (Array.isArray(body.items) && body.items.length > CART_LIMITS.maxLines) {
    throw new Error(`A cart can hold up to ${CART_LIMITS.maxLines} different dishes.`);
  }
  const checkout = parseCheckout(body);
  const limit = cartLimitViolation(checkout.items, checkout.quote.riderTip);
  if (limit) throw new Error(limit);
  const couponProblem = couponIneligibility(checkout.quote.couponCode, {
    isGoldMember: checkout.isGoldMember,
    paymentMethod: checkout.paymentMethod,
    hasOrderedBefore: context.hasOrderedBefore,
  });
  if (couponProblem) throw new Error(couponProblem);
  const slotProblem = deliverySlotProblem(checkout.scheduledSlot, context.now);
  if (slotProblem) throw new Error(slotProblem);
  return checkout;
}

/**
 * Builds an order from input `validateCheckout` has already accepted. It is also how stored
 * orders are replayed, so it deliberately skips the placement-only rules.
 */
export function createDemoOrder(input: unknown): CrystalOrderState {
  const { items, quote, address, restaurant, paymentMethod, scheduledSlot, handling } =
    parseCheckout(input);
  return {
    orderId: `KRV-${newId()}`,
    resId: restaurant.resId,
    restaurantName: restaurant.name,
    restaurantLocality: restaurant.locality,
    customerAddress: address,
    items,
    quote,
    paymentMethod,
    zpaykitTransactionId: "demo-no-payment-collected",
    stage: "ORDER_CONFIRMED",
    etaMinutes: restaurant.deliveryTimeMins,
    scheduledSlot,
    handling,
    placedAt: new Date().toISOString(),
    rider: {
      name: "Demo delivery partner", phone: "", rating: "4.9", deliveriesCount: 0,
      vehicleNumber: "DEMO", vaccinated: false, temperatureText: "Not available", progressPercent: 18,
    },
  };
}

/** Ignore malformed local history; its contents are user-editable, not a server receipt. */
export function restoreOrderHistory(serialized: string | null): CrystalOrderState[] {
  try {
    const parsed: unknown = JSON.parse(serialized || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 50).flatMap((value) => {
      try {
        const order = record(value);
        const quote = record(order.quote);
        const address = record(order.customerAddress);
        if (typeof order.orderId !== "string" || !/^KRV-[a-f0-9-]{36}$/.test(order.orderId) ||
            typeof order.placedAt !== "string" || !Number.isFinite(Date.parse(order.placedAt)) ||
            !ORDER_STAGES.some((stage) => stage === order.stage) || !Array.isArray(order.items)) return [];
        const restored = createDemoOrder({
          addressId: address.id, paymentMethod: order.paymentMethod,
          couponCode: quote.couponCode, isGoldMember: quote.deliveryFee === 0, riderTip: quote.riderTip,
          scheduledSlot: order.scheduledSlot,
          handling: order.handling,
          items: order.items.map((entry) => {
            const line = record(entry);
            const item = record(line.item);
            if (!Array.isArray(line.selectedOptions)) throw new Error("Invalid options.");
            return { itemId: item.id, quantity: line.quantity,
              optionIds: line.selectedOptions.map((option) => record(option).id), cookingInstruction: line.cookingInstruction };
          }),
        });
        const stage = ORDER_STAGES.find((candidate) => candidate === order.stage)!;
        return [{ ...restored, orderId: order.orderId, placedAt: order.placedAt, stage }];
      } catch { return []; }
    });
  } catch { return []; }
}

/**
 * Validate a dining table reservation request against the restaurant catalog
 * and its declared dining slots before confirming a booking.
 */
export function createValidatedReservation(input: unknown): DiningReservation {
  const body = record(input);
  const resId = Number(body.resId);
  const restaurant = RESTAURANTS_DATA.find((candidate) => candidate.resId === resId);
  if (!restaurant || !restaurant.isOpen) {
    throw new Error("Selected restaurant is unavailable for table reservations.");
  }

  const timeSlot = typeof body.timeSlot === "string" ? body.timeSlot.trim() : "";
  const slotObj = restaurant.diningSlots.find((slot) => slot.time === timeSlot);
  if (!slotObj || slotObj.seatsLeft <= 0) {
    throw new Error("Please select an available dining time slot.");
  }

  const guests = Number(body.guests);
  if (!Number.isSafeInteger(guests) || guests < 1 || guests > 20) {
    throw new Error("Guest count must be a whole number between 1 and 20.");
  }

  const date = typeof body.date === "string" ? body.date.trim() : "";
  if (!date || date.length > 60) {
    throw new Error("Please select a valid reservation date.");
  }

  const guestName = typeof body.guestName === "string" ? body.guestName.trim() : "";
  if (guestName.length < 2 || guestName.length > 80) {
    throw new Error("Please enter the guest's full name.");
  }

  const guestPhone = typeof body.guestPhone === "string" ? body.guestPhone.trim() : "";
  if (!/^[+\d][\d\s-]{6,18}$/.test(guestPhone)) {
    throw new Error("Please enter a valid contact phone number.");
  }

  const specialRequest =
    typeof body.specialRequest === "string" ? body.specialRequest.trim().slice(0, 200) : "";
  const isGoldMember = Boolean(body.isGoldMember);
  const membershipName =
    typeof body.membershipName === "string" && body.membershipName.trim()
      ? body.membershipName.trim()
      : "LUXE";

  return {
    // Read aloud at the host stand, so it stays short; 48 random bits still makes a clash on
    // the primary key vanishingly rare, and one would fail the insert before anything else.
    bookingId: `TBL-${newId().replace(/-/g, "").slice(0, 12).toUpperCase()}`,
    resId: restaurant.resId,
    restaurantName: restaurant.name,
    locality: restaurant.locality,
    date,
    timeSlot: slotObj.time,
    mealType: slotObj.mealType,
    guests,
    offerApplied: isGoldMember
      ? `${restaurant.walkinOffer.title} + ${restaurant.walkinOffer.goldExtraPercent}% ${membershipName}`
      : restaurant.walkinOffer.title,
    specialRequest,
    guestName,
    guestPhone,
    status: "CONFIRMED",
    createdAt: new Date().toISOString(),
  };
}

/**
 * The gate for a new booking: everything `createValidatedReservation` checks, plus a real
 * calendar date inside the booking window and a slot still ahead on the outlet's clock.
 * Kept separate because stored bookings replay through `createValidatedReservation`, and a
 * past or pre-ISO booking must stay in history.
 */
export function validateReservationRequest(input: unknown, now: Date = new Date()): DiningReservation {
  const reservation = createValidatedReservation(input);
  const problem = bookingTimeProblem(reservation.date, reservation.timeSlot, now);
  if (problem) throw new Error(problem);
  return reservation;
}

/**
 * Restore saved table reservations from localStorage while discarding malformed entries.
 */
export function restoreReservationHistory(serialized: string | null): DiningReservation[] {
  try {
    const parsed: unknown = JSON.parse(serialized || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 30).flatMap((entry) => {
      try {
        const raw = record(entry);
        if (typeof raw.bookingId !== "string" || !raw.bookingId.startsWith("TBL-")) {
          return [];
        }
        const validated = createValidatedReservation({
          resId: raw.resId,
          date: raw.date,
          timeSlot: raw.timeSlot,
          guests: raw.guests,
          guestName: raw.guestName,
          guestPhone: raw.guestPhone,
          specialRequest: raw.specialRequest,
          isGoldMember: String(raw.offerApplied || "").includes("+"),
        });
        return [
          {
            ...validated,
            bookingId: raw.bookingId,
            offerApplied:
              typeof raw.offerApplied === "string" && raw.offerApplied.trim()
                ? raw.offerApplied
                : validated.offerApplied,
            createdAt:
              typeof raw.createdAt === "string" ? raw.createdAt : validated.createdAt,
          },
        ];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

/**
 * Validate a customer review submission before appending it to restaurant reviews.
 */
export function createValidatedReview(
  input: unknown,
  options: { verifiedPurchase?: boolean } = {}
): RestaurantReview {
  const body = record(input);
  const resId = Number(body.resId);
  const restaurant = RESTAURANTS_DATA.find((candidate) => candidate.resId === resId);
  if (!restaurant) {
    throw new Error("Restaurant not found.");
  }

  const rating = Number(body.rating);
  if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
    throw new Error("Rating must be between 1 and 5 stars.");
  }

  const comment = typeof body.comment === "string" ? body.comment.trim() : "";
  if (comment.length < 5 || comment.length > 600) {
    throw new Error("Please write a review between 5 and 600 characters.");
  }

  const userName =
    typeof body.userName === "string" && body.userName.trim().length >= 2
      ? body.userName.trim().slice(0, 60)
      : "Krave Diner";

  const initials = userName
    .split(/\s+/)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("")
    .slice(0, 2) || "VD";

  const verifiedPurchase = options.verifiedPurchase === true;

  return {
    id: `rev_${newId()}`,
    userName,
    userAvatar: initials,
    userHandle: `@${userName.toLowerCase().replace(/[^a-z0-9]+/g, ".")}`,
    reviewType: body.reviewType === "DELIVERY" ? "DELIVERY" : "DINING",
    rating: Math.round(rating * 10) / 10,
    timestamp: "Just now",
    comment,
    // The claim is only made when the server could actually confirm it.
    positiveTags: verifiedPurchase ? ["Verified Order"] : [],
    verifiedPurchase,
    likes: 1,
  };
}

export interface KraveSessionState {
  cartItems: CartLineItem[];
  addressId: string;
  themeId: string;
  isDark: boolean;
  mode: DiscoveryTabKey;
  isGoldMember: boolean;
  couponCode: string | null;
  riderTip: number;
  handling: KitchenHandling;
  scheduledSlot: string;
}

/** Store only what identifies a cart line; prices are always rebuilt from the catalog. */
export function serializeSessionState(state: KraveSessionState): string {
  return JSON.stringify({
    addressId: state.addressId,
    themeId: state.themeId,
    isDark: state.isDark,
    mode: state.mode,
    isGoldMember: state.isGoldMember,
    couponCode: state.couponCode,
    riderTip: state.riderTip,
    // Saved with the cart, not separately: an allergy that outlives its items, or items
    // that outlive their allergy, are both worse than losing the pair together.
    handling: state.handling,
    scheduledSlot: state.scheduledSlot,
    items: state.cartItems.map((line) => ({
      itemId: line.item.id,
      quantity: line.quantity,
      optionIds: line.selectedOptions.map((option) => option.id),
      cookingInstruction: line.cookingInstruction,
    })),
  });
}

/**
 * Rebuild the browsing session saved before a refresh. Items that no longer exist in the
 * catalog are dropped rather than failing the whole restore, so a menu change cannot strand
 * the customer with an unusable cart.
 */
export function restoreSessionState(serialized: string | null): KraveSessionState | null {
  let body: Record<string, unknown>;
  try {
    body = record(JSON.parse(serialized || "null"));
  } catch {
    return null;
  }

  let cartItems: CartLineItem[] = [];
  if (Array.isArray(body.items)) {
    for (const entry of body.items) {
      try {
        const line = record(entry);
        if (typeof line.itemId !== "string" || typeof line.quantity !== "number") continue;
        const found = findDishAcrossRestaurants(line.itemId);
        if (!found) continue;
        if (cartItems.length && cartItems[0].resId !== found.restaurant.resId) continue;
        const optionIds = new Set(
          Array.isArray(line.optionIds) ? line.optionIds.filter((id) => typeof id === "string") : []
        );
        const options = found.dish.modifier_group_ids
          .flatMap((id) => found.restaurant.modifierGroups[id].options)
          .filter((option) => optionIds.has(option.id));
        cartItems = addOrIncrementCartItem(
          cartItems,
          found.restaurant,
          found.dish,
          line.quantity,
          options,
          typeof line.cookingInstruction === "string"
            ? line.cookingInstruction.slice(0, CART_LIMITS.maxInstructionLength)
            : undefined
        );
      } catch {
        continue;
      }
    }
  }
  // A cart saved before the limits existed is trimmed to one that can still be placed.
  cartItems = cartItems.slice(0, CART_LIMITS.maxLines).map((line) =>
    line.quantity > CART_LIMITS.maxLineQuantity
      ? { ...line, quantity: CART_LIMITS.maxLineQuantity }
      : line
  );

  const address = SAVED_ADDRESSES.find((candidate) => candidate.id === body.addressId);
  const theme = BRAND_THEME_PRESETS.find((candidate) => candidate.id === body.themeId);
  const mode = DISCOVERY_MODES.find((candidate) => candidate === body.mode);
  const savedCoupon =
    typeof body.couponCode === "string" ? body.couponCode.trim().toUpperCase() : null;
  const couponCode =
    savedCoupon && COUPON_OFFERS.some((offer) => offer.code === savedCoupon) ? savedCoupon : null;
  const riderTip =
    typeof body.riderTip === "number" && Number.isSafeInteger(body.riderTip)
      ? Math.min(Math.max(body.riderTip, 0), MAX_RIDER_TIP)
      : 0;

  // Browser storage is user-editable, so stored handling is re-validated rather than trusted.
  let handling: KitchenHandling;
  try {
    handling = validateKitchenHandling(body.handling);
  } catch {
    handling = EMPTY_HANDLING;
  }

  return {
    cartItems,
    addressId: address?.id ?? SAVED_ADDRESSES[0].id,
    themeId: theme?.id ?? BRAND_THEME_PRESETS[0].id,
    isDark: typeof body.isDark === "boolean" ? body.isDark : true,
    mode: mode ?? "delivery",
    isGoldMember: typeof body.isGoldMember === "boolean" ? body.isGoldMember : true,
    couponCode,
    riderTip,
    handling,
    scheduledSlot:
      DELIVERY_SLOTS.find((slot) => slot === body.scheduledSlot) ?? DELIVERY_SLOTS[0],
  };
}

/**
 * A demo order may only be withdrawn before the kitchen is told to start cooking.
 * Later stages are deliberately irreversible so cancellation cannot rewrite history.
 */
export function cancelDemoOrder(
  history: CrystalOrderState[],
  orderId: string
): CrystalOrderState[] {
  const order = history.find((candidate) => candidate.orderId === orderId);
  if (!order) {
    throw new Error("That order is no longer in your history.");
  }
  if (order.stage !== "ORDER_CONFIRMED") {
    throw new Error("This order has already reached the kitchen and cannot be cancelled.");
  }
  return history.filter((candidate) => candidate.orderId !== orderId);
}

/**
 * Dishes marked off ("86"). The authoritative list is per outlet on the server; this
 * restores the browser's cached copy, which is all a signed-out device has.
 */
export function restoreAvailability(serialized: string | null): string[] {
  try {
    const parsed: unknown = JSON.parse(serialized || "[]");
    if (!Array.isArray(parsed)) return [];
    const known = parsed.filter(
      (id): id is string => typeof id === "string" && Boolean(findDishAcrossRestaurants(id))
    );
    return [...new Set(known)].slice(0, 500);
  } catch {
    return [];
  }
}

export function toggleDishAvailability(unavailableIds: string[], itemId: string): string[] {
  if (!findDishAcrossRestaurants(itemId)) {
    throw new Error("That dish is not on any menu.");
  }
  return unavailableIds.includes(itemId)
    ? unavailableIds.filter((id) => id !== itemId)
    : [...unavailableIds, itemId];
}

/**
 * Refuse a cart containing a dish the kitchen has taken off. Kept separate from
 * `validateCheckout` on purpose: replaying an old order through the validator must not
 * fail just because something sold out long after it was delivered.
 */
export function assertItemsAvailable(
  items: { item: { id: string; name: string } }[],
  unavailableItemIds: string[]
): void {
  if (unavailableItemIds.length === 0) return;
  const blocked = items.find((line) => unavailableItemIds.includes(line.item.id));
  if (blocked) {
    throw new Error(`${blocked.item.name} just sold out. Remove it to continue.`);
  }
}

/**
 * Resolve when a requested window actually falls due, on the outlet's clock (IST) whatever
 * zone the server runs in. Also used to replay stored orders, so it never throws.
 */
export function scheduledDueAt(slot: string, placedAt: string | Date = new Date()): Date {
  const placed = placedAt instanceof Date ? placedAt : new Date(placedAt);
  const base = Number.isFinite(placed.getTime()) ? placed : new Date();

  switch (slot) {
    case "In 1 hour":
      return new Date(base.getTime() + 60 * 60 * 1000);
    case "In 2 hours":
      return new Date(base.getTime() + 2 * 60 * 60 * 1000);
    case "Tonight, 8:00 PM": {
      const tonight = atOutletClock(base, 20, 0);
      // New orders cannot pick a passed window (see deliverySlotProblem); an order placed before
      // that rule still resolves to the next 8 PM rather than one already gone.
      return tonight > base ? tonight : atOutletClock(base, 20, 0, 1);
    }
    case "Tomorrow, 12:30 PM":
      return atOutletClock(base, 12, 30, 1);
    default:
      return base;
  }
}

/** Why a delivery window can no longer be chosen at `now`, or null when it can. */
export function deliverySlotProblem(slot: string, now: Date = new Date()): string | null {
  if (slot === "Tonight, 8:00 PM" && now.getTime() >= atOutletClock(now, 20, 0).getTime()) {
    return "Tonight's 8:00 PM window has passed. Please choose another time.";
  }
  return null;
}

export type KraveNotificationKind = "ORDER" | "RESERVATION" | "SYSTEM";

export interface KraveNotification {
  id: string;
  kind: KraveNotificationKind;
  title: string;
  body: string;
  createdAt: string;
  read: boolean;
}

const NOTIFICATION_KINDS: KraveNotificationKind[] = ["ORDER", "RESERVATION", "SYSTEM"];

export function createNotification(
  kind: KraveNotificationKind,
  title: string,
  body: string
): KraveNotification {
  return {
    // Full length: a clash on this primary key used to fail after the order was already saved.
    id: `ntf_${newId()}`,
    kind,
    title: title.trim().slice(0, 90),
    body: body.trim().slice(0, 240),
    createdAt: new Date().toISOString(),
    read: false,
  };
}

/** Local inbox only. Nothing is pushed, emailed, or sent to a device notification service. */
export function restoreNotifications(serialized: string | null): KraveNotification[] {
  try {
    const parsed: unknown = JSON.parse(serialized || "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 40).flatMap((entry): KraveNotification[] => {
      try {
        const raw = record(entry);
        if (
          typeof raw.id !== "string" ||
          !raw.id.startsWith("ntf_") ||
          !NOTIFICATION_KINDS.some((kind) => kind === raw.kind) ||
          typeof raw.title !== "string" ||
          typeof raw.body !== "string" ||
          typeof raw.createdAt !== "string" ||
          !Number.isFinite(Date.parse(raw.createdAt))
        ) {
          return [];
        }
        return [
          {
            id: raw.id,
            kind: raw.kind as KraveNotificationKind,
            title: raw.title.slice(0, 90),
            body: raw.body.slice(0, 240),
            createdAt: raw.createdAt,
            read: raw.read === true,
          },
        ];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}
