import { COUPON_OFFERS, RESTAURANTS_DATA } from "@/data/zomatoReconstructedData";
import {
  CartLineItem,
  CartQuote,
  DiscoveryTabKey,
  DishItem,
  ModifierGroup,
  ModifierOption,
  RestaurantEntity,
} from "@/types/krave";

export interface RestaurantFilterCriteria {
  mode: DiscoveryTabKey;
  query?: string;
  collectionId?: number | null;
  pureVegOnly?: boolean;
  minRating?: number;
  fastDeliveryOnly?: boolean;
  hasWalkinOfferOnly?: boolean;
  cuisineFilter?: string | null;
  sortBy?: "relevance" | "rating_desc" | "delivery_time" | "cost_asc" | "cost_desc";
}

export function filterAndSortRestaurants(
  restaurants: RestaurantEntity[],
  criteria: RestaurantFilterCriteria
): RestaurantEntity[] {
  const normalizedQuery = (criteria.query || "").trim().toLowerCase();

  const filtered = restaurants.filter((res) => {
    if (!res.modes.includes(criteria.mode)) {
      return false;
    }
    if (criteria.collectionId && !res.collectionIds.includes(criteria.collectionId)) {
      return false;
    }
    if (criteria.pureVegOnly && !res.pureVeg) {
      return false;
    }
    if (criteria.fastDeliveryOnly && res.deliveryTimeMins > 28) {
      return false;
    }
    if (criteria.hasWalkinOfferOnly && res.walkinOffer.basePercent < 15) {
      return false;
    }
    if (criteria.cuisineFilter) {
      const target = criteria.cuisineFilter.toLowerCase();
      if (!res.cuisines.some((c) => c.toLowerCase().includes(target))) {
        return false;
      }
    }
    if (criteria.minRating) {
      const activeRating = parseFloat(
        criteria.mode === "delivery" ? res.ratings.DELIVERY.rating : res.ratings.DINING.rating
      );
      if (activeRating < criteria.minRating) {
        return false;
      }
    }
    if (normalizedQuery) {
      const nameMatch = res.name.toLowerCase().includes(normalizedQuery);
      const cuisineMatch = res.cuisines.some((c) => c.toLowerCase().includes(normalizedQuery));
      const localityMatch = res.locality.toLowerCase().includes(normalizedQuery);
      const dishMatch = res.menus.some((m) =>
        m.categories.some((sc) =>
          sc.items.some(
            (item) =>
              item.name.toLowerCase().includes(normalizedQuery) ||
              item.desc.toLowerCase().includes(normalizedQuery)
          )
        )
      );
      if (!nameMatch && !cuisineMatch && !localityMatch && !dishMatch) {
        return false;
      }
    }
    return true;
  });

  const sorted = [...filtered];
  switch (criteria.sortBy) {
    case "rating_desc":
      sorted.sort((a, b) => {
        const rA = parseFloat(
          criteria.mode === "delivery" ? a.ratings.DELIVERY.rating : a.ratings.DINING.rating
        );
        const rB = parseFloat(
          criteria.mode === "delivery" ? b.ratings.DELIVERY.rating : b.ratings.DINING.rating
        );
        return rB - rA;
      });
      break;
    case "delivery_time":
      sorted.sort((a, b) => a.deliveryTimeMins - b.deliveryTimeMins);
      break;
    case "cost_asc":
      sorted.sort((a, b) => a.costForTwo - b.costForTwo);
      break;
    case "cost_desc":
      sorted.sort((a, b) => b.costForTwo - a.costForTwo);
      break;
    case "relevance":
    default:
      sorted.sort((a, b) => Number(b.isPromoted) - Number(a.isPromoted));
      break;
  }

  return sorted;
}

export function buildLineItemId(itemId: string, selectedOptions: ModifierOption[]): string {
  const optionKey =
    selectedOptions.length > 0
      ? selectedOptions
          .map((o) => o.id)
          .sort()
          .join("+")
      : "base";
  return `${itemId}__${optionKey}`;
}

function validateQuantity(quantity: number, allowZero = false): void {
  if (!Number.isSafeInteger(quantity) || quantity < (allowZero ? 0 : 1)) {
    throw new Error("Quantity must be a positive whole number; use zero to remove a cart line.");
  }
}

/**
 * Limits checked when an order is placed, never when a stored order is replayed: tightening
 * a limit must not erase history that was valid when it was written.
 */
export const CART_LIMITS = {
  maxLineQuantity: 50,
  maxLines: 30,
  maxInstructionLength: 200,
  maxRiderTip: 500,
} as const;

/** Why this cart cannot be placed as it stands, or null. */
export function cartLimitViolation(items: CartLineItem[], riderTip = 0): string | null {
  if (items.length > CART_LIMITS.maxLines) {
    return `A cart can hold up to ${CART_LIMITS.maxLines} different dishes.`;
  }
  for (const line of items) {
    if (line.quantity > CART_LIMITS.maxLineQuantity) {
      return `You can order up to ${CART_LIMITS.maxLineQuantity} of ${line.item.name} at a time.`;
    }
    if ((line.cookingInstruction?.length ?? 0) > CART_LIMITS.maxInstructionLength) {
      return `Keep the note for ${line.item.name} to ${CART_LIMITS.maxInstructionLength} characters.`;
    }
  }
  if (riderTip > CART_LIMITS.maxRiderTip) {
    return `Rider tips are capped at ₹${CART_LIMITS.maxRiderTip}.`;
  }
  return null;
}

export interface CouponContext {
  isGoldMember: boolean;
  /** Payment-bound offers are only judged once a method is known. */
  paymentMethod?: string;
  /** First-order offers are only judged when the customer's history is known. */
  hasOrderedBefore?: boolean;
}

/**
 * Why this customer cannot use a coupon, or null. Cart-size rules (`minOrder`) stay in
 * `calculateCartQuote`; these are about who is paying and how, so they are checked at
 * placement and in the browser's quote, but not when a stored order is replayed.
 */
export function couponIneligibility(
  code: string | null | undefined,
  context: CouponContext
): string | null {
  if (!code) return null;
  const coupon = COUPON_OFFERS.find((offer) => offer.code === code.trim().toUpperCase());
  if (!coupon) return null;
  if (coupon.membersOnly && !context.isGoldMember) {
    return `${coupon.code} is a members-only offer.`;
  }
  if (
    coupon.requiresPaymentMethod &&
    context.paymentMethod !== undefined &&
    context.paymentMethod !== coupon.requiresPaymentMethod
  ) {
    return `${coupon.code} applies only when you pay with ${coupon.requiresPaymentMethod}.`;
  }
  if (coupon.firstOrderOnly && context.hasOrderedBefore === true) {
    return `${coupon.code} is a welcome offer for a first order.`;
  }
  return null;
}

/** The options a dish starts with: each group's defaults, topped up to its minimum. */
export function defaultModifierSelection(groups: ModifierGroup[]): ModifierOption[] {
  return groups.flatMap((group) => {
    const chosen = group.options.filter((option) => option.isDefault).slice(0, group.maxSelect);
    for (const option of group.options) {
      if (chosen.length >= group.minSelect) break;
      if (!chosen.includes(option)) chosen.push(option);
    }
    return chosen;
  });
}

/**
 * Select or clear one option. A single choice swaps; a required single choice cannot be
 * emptied; a multi-choice stops at its maximum. Returns `selected` itself when nothing changes.
 */
export function applyModifierToggle(
  group: ModifierGroup,
  selected: ModifierOption[],
  option: ModifierOption
): ModifierOption[] {
  const inGroup = new Set(group.options.map((candidate) => candidate.id));
  if (!inGroup.has(option.id)) return selected;
  if (selected.some((candidate) => candidate.id === option.id)) {
    if (group.maxSelect === 1 && group.minSelect >= 1) return selected;
    return selected.filter((candidate) => candidate.id !== option.id);
  }
  if (group.maxSelect === 1) {
    return [...selected.filter((candidate) => !inGroup.has(candidate.id)), option];
  }
  const countInGroup = selected.filter((candidate) => inGroup.has(candidate.id)).length;
  return countInGroup < group.maxSelect ? [...selected, option] : selected;
}

/** The first group whose selection breaks its rules, as a message for the customer. */
export function modifierSelectionProblem(
  groups: ModifierGroup[],
  selectedIds: ReadonlySet<string>
): string | null {
  for (const group of groups) {
    const count = group.options.filter((option) => selectedIds.has(option.id)).length;
    if (count < group.minSelect) {
      return group.minSelect === 1
        ? `Choose an option for ${group.title}.`
        : `Choose at least ${group.minSelect} for ${group.title}.`;
    }
    if (count > group.maxSelect) {
      return `Choose up to ${group.maxSelect} for ${group.title}.`;
    }
  }
  return null;
}

export function dishModifierGroups(
  restaurant: Pick<RestaurantEntity, "modifierGroups">,
  dish: Pick<DishItem, "modifier_group_ids">
): ModifierGroup[] {
  return dish.modifier_group_ids.flatMap((id) => {
    const group = restaurant.modifierGroups[id];
    return group ? [group] : [];
  });
}

export function addOrIncrementCartItem(
  currentItems: CartLineItem[],
  restaurant: Pick<RestaurantEntity, "resId" | "name">,
  item: DishItem,
  quantity: number,
  selectedOptions: ModifierOption[] = [],
  cookingInstruction?: string
): CartLineItem[] {
  validateQuantity(quantity);
  // If adding from a different restaurant, replace cart for the new restaurant
  const baseList =
    currentItems.length > 0 && currentItems[0].resId !== restaurant.resId ? [] : [...currentItems];

  const lineItemId = buildLineItemId(item.id, selectedOptions);
  const optionsSum = selectedOptions.reduce((sum, opt) => sum + opt.price, 0);
  const unitPrice = Math.round(item.price + optionsSum);
  if (!Number.isSafeInteger(unitPrice) || unitPrice < 0) {
    throw new Error("Item price must be a finite, non-negative amount.");
  }

  const existingIndex = baseList.findIndex((li) => li.lineItemId === lineItemId);
  if (existingIndex >= 0) {
    const existing = baseList[existingIndex];
    validateQuantity(existing.quantity + quantity);
    baseList[existingIndex] = {
      ...existing,
      quantity: existing.quantity + quantity,
      cookingInstruction: cookingInstruction ?? existing.cookingInstruction,
    };
    return baseList;
  }

  return [
    ...baseList,
    {
      lineItemId,
      resId: restaurant.resId,
      restaurantName: restaurant.name,
      item,
      quantity,
      selectedOptions,
      unitPrice,
      cookingInstruction,
    },
  ];
}

export function updateCartLineQuantity(
  currentItems: CartLineItem[],
  lineItemId: string,
  quantity: number
): CartLineItem[] {
  validateQuantity(quantity, true);
  if (quantity === 0) {
    return currentItems.filter((li) => li.lineItemId !== lineItemId);
  }
  return currentItems.map((li) => (li.lineItemId === lineItemId ? { ...li, quantity } : li));
}

/**
 * The cart left once `ordered` has been bought. Only what was ordered is taken out: a line
 * added (or a quantity raised) in another tab while checkout was in flight stays in the cart.
 */
export function removeOrderedLines(
  currentItems: CartLineItem[],
  ordered: CartLineItem[]
): CartLineItem[] {
  const bought = new Map<string, number>();
  for (const line of ordered) {
    bought.set(line.lineItemId, (bought.get(line.lineItemId) ?? 0) + line.quantity);
  }
  const remaining = currentItems.flatMap((line) => {
    const quantity = line.quantity - (bought.get(line.lineItemId) ?? 0);
    if (quantity <= 0) return [];
    return [quantity === line.quantity ? line : { ...line, quantity }];
  });
  return remaining.length === currentItems.length &&
    remaining.every((line, index) => line === currentItems[index])
    ? currentItems
    : remaining;
}

/**
 * Single source of truth for fees, so what a listing card promises and what checkout
 * charges cannot drift apart.
 */
export const FEE_SCHEDULE = {
  platformFee: 10,
  packagingPerItem: 15,
  packagingCap: 60,
  deliveryFee: 49,
  reducedDeliveryFee: 25,
  reducedDeliveryOver: 699,
  gstPercent: 5,
} as const;

export function calculateCartQuote(
  items: CartLineItem[],
  options: {
    couponCode?: string | null;
    isGoldMember?: boolean;
    riderTip?: number;
  } = {}
): CartQuote {
  for (const line of items) {
    validateQuantity(line.quantity);
    if (line.resId !== items[0].resId) {
      throw new Error("A cart can contain items from only one restaurant.");
    }
    if (!Number.isSafeInteger(line.unitPrice) || line.unitPrice < 0) {
      throw new Error("Item price must be a finite, non-negative amount.");
    }
  }
  if (options.riderTip !== undefined &&
      (!Number.isSafeInteger(options.riderTip) || options.riderTip < 0)) {
    throw new Error("Rider tip must be a non-negative whole amount.");
  }
  if (items.length === 0) {
    return {
      quoteId: "qt_empty",
      resId: null,
      itemCount: 0,
      itemTotal: 0,
      couponCode: null,
      couponDiscount: 0,
      goldDiscount: 0,
      packagingFee: 0,
      platformFee: 0,
      deliveryFee: 0,
      gstAndCharges: 0,
      riderTip: 0,
      lockAdjustment: 0,
      grandTotal: 0,
      totalSavings: 0,
    };
  }

  const resId = items[0].resId;
  const itemCount = items.reduce((sum, li) => sum + li.quantity, 0);
  const itemTotal = items.reduce((sum, li) => sum + li.unitPrice * li.quantity, 0);
  if (!Number.isSafeInteger(itemCount) || !Number.isSafeInteger(itemTotal)) {
    throw new Error("Cart exceeds the supported quantity or amount.");
  }

  let couponDiscount = 0;
  let validCouponCode: string | null = null;
  if (options.couponCode) {
    const normalized = options.couponCode.trim().toUpperCase();
    const coupon = COUPON_OFFERS.find((c) => c.code === normalized);
    if (coupon && itemTotal >= coupon.minOrder) {
      validCouponCode = coupon.code;
      if (coupon.discountType === "PERCENT") {
        couponDiscount = Math.min(Math.round((itemTotal * coupon.value) / 100), coupon.maxDiscount);
      } else {
        couponDiscount = Math.min(coupon.value, coupon.maxDiscount);
      }
    }
  }

  const isGold = Boolean(options.isGoldMember);
  const goldDiscount = isGold ? Math.round(itemTotal * 0.05) : 0;
  const packagingFee = Math.min(
    FEE_SCHEDULE.packagingCap,
    itemCount * FEE_SCHEDULE.packagingPerItem
  );
  const platformFee = FEE_SCHEDULE.platformFee;
  const standardDeliveryFee =
    itemTotal >= FEE_SCHEDULE.reducedDeliveryOver
      ? FEE_SCHEDULE.reducedDeliveryFee
      : FEE_SCHEDULE.deliveryFee;
  const deliveryFee = isGold ? 0 : standardDeliveryFee;
  const taxableAmount = Math.max(0, itemTotal - couponDiscount - goldDiscount);
  const gstAndCharges =
    Math.round((taxableAmount * FEE_SCHEDULE.gstPercent) / 100) + packagingFee;
  const riderTip = Math.max(0, options.riderTip || 0);

  const grandTotal = Math.max(
    0,
    taxableAmount + gstAndCharges + platformFee + deliveryFee + riderTip
  );
  if (!Number.isSafeInteger(grandTotal)) {
    throw new Error("Cart total exceeds the supported amount.");
  }
  const totalSavings = couponDiscount + goldDiscount + (isGold ? standardDeliveryFee : 0);

  return {
    quoteId: `qt_${resId}_${itemTotal}_${validCouponCode || "nocode"}`,
    resId,
    itemCount,
    itemTotal,
    couponCode: validCouponCode,
    couponDiscount,
    goldDiscount,
    packagingFee,
    platformFee,
    deliveryFee,
    gstAndCharges,
    riderTip,
    lockAdjustment: 0,
    grandTotal,
    totalSavings,
  };
}

export function calculateDiningPayBill(
  billAmount: number,
  restaurant: Pick<RestaurantEntity, "walkinOffer">,
  isGoldMember: boolean
) {
  const cleanAmount = Math.max(0, Math.round(billAmount));
  const baseDiscount = Math.round((cleanAmount * restaurant.walkinOffer.basePercent) / 100);
  const afterBase = Math.max(0, cleanAmount - baseDiscount);
  const goldExtraDiscount = isGoldMember
    ? Math.round((afterBase * restaurant.walkinOffer.goldExtraPercent) / 100)
    : 0;
  const convenienceFee = cleanAmount > 0 ? 15 : 0;
  const finalPayable = Math.max(0, cleanAmount - baseDiscount - goldExtraDiscount + convenienceFee);

  return {
    billAmount: cleanAmount,
    baseDiscount,
    goldExtraDiscount,
    totalSaved: baseDiscount + goldExtraDiscount,
    convenienceFee,
    finalPayable,
  };
}

export function findDishAcrossRestaurants(itemId: string): {
  restaurant: RestaurantEntity;
  dish: DishItem;
} | null {
  for (const res of RESTAURANTS_DATA) {
    for (const menu of res.menus) {
      for (const sub of menu.categories) {
        for (const item of sub.items) {
          if (item.id === itemId) {
            return { restaurant: res, dish: item };
          }
        }
      }
    }
  }
  return null;
}
