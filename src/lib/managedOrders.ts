/**
 * Pricing, lifecycle and opening-hours rules for orders placed from a managed restaurant
 * menu (`/r/[slug]`). Shared by the browser cart and the server, so the total a customer
 * sees is computed by the same function that the server uses to decide what to record.
 * The server never trusts a client total: it recomputes from the database and refuses the
 * order when the two differ.
 */

export type OrderFulfilment = "takeaway" | "dine_in" | "delivery";

export const ORDER_FULFILMENTS: readonly OrderFulfilment[] = ["takeaway", "dine_in", "delivery"];

export const FULFILMENT_LABELS: Record<OrderFulfilment, string> = {
  takeaway: "Takeaway",
  dine_in: "Dine-in",
  delivery: "Delivery",
};

export type RestaurantOrderStatus =
  | "placed"
  | "accepted"
  | "preparing"
  | "ready"
  | "completed"
  | "cancelled"
  | "rejected";

export const ORDER_STATUS_LABELS: Record<RestaurantOrderStatus, string> = {
  placed: "Waiting for the restaurant",
  accepted: "Accepted",
  preparing: "Being prepared",
  ready: "Ready",
  completed: "Completed",
  cancelled: "Cancelled",
  rejected: "Declined by the restaurant",
};

/** What the restaurant may do next from each status. Terminal statuses allow nothing. */
export const OWNER_ORDER_TRANSITIONS: Record<RestaurantOrderStatus, readonly RestaurantOrderStatus[]> = {
  placed: ["accepted", "rejected"],
  accepted: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
  rejected: [],
};

export const ACTIVE_ORDER_STATUSES: readonly RestaurantOrderStatus[] = ["placed", "accepted", "preparing", "ready"];

export function isTerminalOrderStatus(status: RestaurantOrderStatus): boolean {
  return OWNER_ORDER_TRANSITIONS[status].length === 0;
}

/** A customer may withdraw an order only before the kitchen has accepted it. */
export function customerCanCancel(status: RestaurantOrderStatus): boolean {
  return status === "placed";
}

export const MAX_ORDER_LINES = 30;
export const MAX_LINE_QUANTITY = 20;
export const MAX_ADDONS_PER_LINE = 10;
/** ₹1,00,000. Larger orders are refused with a request to phone the restaurant. */
export const MAX_ORDER_TOTAL_PAISE = 10_000_000;

export interface PricedItem {
  pricePaise: number;
  discountedPricePaise: number | null;
  variants: ReadonlyArray<{ id: string; priceDeltaPaise: number }>;
  addons: ReadonlyArray<{ id: string; pricePaise: number }>;
}

/**
 * The price of one unit: the item's own price (its discounted price when set), plus the
 * chosen portion's difference, plus each add-on. Returns null when the portion or an
 * add-on is not offered for this item, or when an item with portions has none chosen.
 */
export function unitPricePaise(
  item: PricedItem,
  variantId: string | null,
  addonIds: readonly string[]
): number | null {
  let price = item.discountedPricePaise ?? item.pricePaise;
  if (item.variants.length > 0) {
    const variant = item.variants.find((candidate) => candidate.id === variantId);
    if (!variant) return null;
    price += variant.priceDeltaPaise;
  } else if (variantId !== null) {
    return null;
  }
  if (new Set(addonIds).size !== addonIds.length) return null;
  for (const addonId of addonIds) {
    const addon = item.addons.find((candidate) => candidate.id === addonId);
    if (!addon) return null;
    price += addon.pricePaise;
  }
  return price;
}

export interface OrderCharges {
  fulfilment: OrderFulfilment;
  deliveryFeePaise: number;
  taxEnabled: boolean;
  taxRateBps: number;
}

export interface OrderTotals {
  subtotalPaise: number;
  deliveryFeePaise: number;
  taxPaise: number;
  totalPaise: number;
}

/**
 * Tax is charged on the food subtotal only, rounded to the nearest paisa (half up); the
 * delivery fee is added untaxed. Inputs are integer paise, so there is no float drift.
 */
export function orderTotals(subtotalPaise: number, charges: OrderCharges): OrderTotals {
  const deliveryFeePaise = charges.fulfilment === "delivery" ? charges.deliveryFeePaise : 0;
  const taxPaise = charges.taxEnabled ? Math.round((subtotalPaise * charges.taxRateBps) / 10_000) : 0;
  return {
    subtotalPaise,
    deliveryFeePaise,
    taxPaise,
    totalPaise: subtotalPaise + deliveryFeePaise + taxPaise,
  };
}

export interface OpeningHours {
  weekday: number;
  opensAt: string | null;
  closesAt: string | null;
  isClosed: boolean;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidClockTime(value: unknown): value is string {
  return typeof value === "string" && TIME_PATTERN.test(value);
}

function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** Weekday (0 = Sunday) and minutes since midnight at `at`, in the restaurant's zone. */
export function localClock(at: Date, timeZone: string): { weekday: number; minutes: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(part("weekday"));
  return { weekday, minutes: Number(part("hour")) * 60 + Number(part("minute")) };
}

/**
 * Whether the kitchen is open at `at`. With no hours configured, opening hours impose
 * nothing and the owner's "accepting orders" switch alone decides. A window whose closing
 * time is at or before its opening time runs past midnight into the next day.
 */
export function isWithinOpeningHours(hours: readonly OpeningHours[], at: Date, timeZone: string): boolean {
  if (hours.length === 0) return true;
  const { weekday, minutes } = localClock(at, timeZone);
  const today = hours.find((day) => day.weekday === weekday);
  if (today && !today.isClosed && today.opensAt && today.closesAt) {
    const opens = minutesOf(today.opensAt);
    const closes = minutesOf(today.closesAt);
    if (closes > opens ? minutes >= opens && minutes < closes : minutes >= opens) return true;
  }
  const yesterday = hours.find((day) => day.weekday === (weekday + 6) % 7);
  if (yesterday && !yesterday.isClosed && yesterday.opensAt && yesterday.closesAt) {
    const opens = minutesOf(yesterday.opensAt);
    const closes = minutesOf(yesterday.closesAt);
    if (closes <= opens && minutes < closes) return true;
  }
  return false;
}

export const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

/** Formats integer paise as rupees, e.g. 12050 → "₹120.50", 12000 → "₹120". */
export function formatPaise(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: paise % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(paise / 100);
}
