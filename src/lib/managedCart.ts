/**
 * The customer's cart for one restaurant's managed menu, and the details they order with.
 *
 * Pure and framework-free so the reducer and pricing are unit-tested without React. The
 * cart lives in localStorage (see persistedStore) and is user-editable, so everything read
 * back is validated; the server re-prices every order regardless.
 */
import {
  MAX_ADDONS_PER_LINE,
  MAX_LINE_QUANTITY,
  MAX_ORDER_LINES,
  ORDER_FULFILMENTS,
  orderTotals,
  unitPricePaise,
  type OrderFulfilment,
  type OrderTotals,
} from "./managedOrders";

export interface OrderableItem {
  id: string;
  name: string;
  pricePaise: number;
  discountedPricePaise: number | null;
  variants: { id: string; name: string; priceDeltaPaise: number }[];
  addons: { id: string; name: string; pricePaise: number }[];
}

export interface CartLine {
  itemId: string;
  variantId: string | null;
  /** Sorted, so the same dish with the same add-ons is one line however it was picked. */
  addonIds: string[];
  quantity: number;
}

export interface Cart {
  lines: CartLine[];
  note: string;
  /**
   * Idempotency key of the checkout attempt in progress. Kept across a failed or
   * interrupted submit (and a page refresh) so a retry cannot place a second order;
   * dropped whenever what would be ordered changes.
   */
  checkoutKey: string | null;
}

export const EMPTY_CART: Cart = { lines: [], note: "", checkoutKey: null };

export const MAX_NOTE_LENGTH = 300;

const ID = /^[A-Za-z0-9_-]{1,100}$/;
const KEY = /^[A-Za-z0-9_-]{16,100}$/;

export function lineKey(line: Pick<CartLine, "itemId" | "variantId" | "addonIds">): string {
  return `${line.itemId}|${line.variantId ?? ""}|${line.addonIds.join(",")}`;
}

function parseLine(raw: unknown): CartLine | null {
  if (!raw || typeof raw !== "object") return null;
  const line = raw as Record<string, unknown>;
  const addonIds = Array.isArray(line.addonIds) ? line.addonIds : [];
  if (
    typeof line.itemId !== "string" || !ID.test(line.itemId) ||
    (line.variantId !== null && (typeof line.variantId !== "string" || !ID.test(line.variantId))) ||
    addonIds.length > MAX_ADDONS_PER_LINE ||
    !addonIds.every((id) => typeof id === "string" && ID.test(id)) ||
    !Number.isInteger(line.quantity) || (line.quantity as number) < 1 || (line.quantity as number) > MAX_LINE_QUANTITY
  ) {
    return null;
  }
  return {
    itemId: line.itemId,
    variantId: line.variantId as string | null,
    addonIds: [...new Set(addonIds as string[])].sort(),
    quantity: line.quantity as number,
  };
}

/** Reads stored text back into a cart, dropping anything malformed rather than failing. */
export function parseCart(raw: string | null): Cart {
  if (!raw) return EMPTY_CART;
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (data?.v !== 1) return EMPTY_CART;
  const seen = new Set<string>();
  const lines: CartLine[] = [];
  for (const candidate of Array.isArray(data.lines) ? data.lines : []) {
    const line = parseLine(candidate);
    if (!line || seen.has(lineKey(line)) || lines.length >= MAX_ORDER_LINES) continue;
    seen.add(lineKey(line));
    lines.push(line);
  }
  return {
    lines,
    note: typeof data.note === "string" ? data.note.slice(0, MAX_NOTE_LENGTH) : "",
    checkoutKey: typeof data.checkoutKey === "string" && KEY.test(data.checkoutKey) ? data.checkoutKey : null,
  };
}

export function serializeCart(cart: Cart): string {
  return JSON.stringify({ v: 1, ...cart });
}

export type CartAction =
  | { type: "add"; line: CartLine }
  | { type: "setQuantity"; key: string; quantity: number }
  | { type: "remove"; key: string }
  | { type: "setNote"; note: string }
  | { type: "beginCheckout"; key: string }
  | { type: "detailsChanged" }
  | { type: "clear" };

/** Every change to what would be ordered drops the checkout key; see `Cart.checkoutKey`. */
export function cartReducer(cart: Cart, action: CartAction): Cart {
  switch (action.type) {
    case "add": {
      const added = { ...action.line, addonIds: [...new Set(action.line.addonIds)].sort() };
      const key = lineKey(added);
      const existing = cart.lines.find((line) => lineKey(line) === key);
      if (existing) {
        const quantity = Math.min(MAX_LINE_QUANTITY, existing.quantity + added.quantity);
        if (quantity === existing.quantity) return cart;
        return {
          ...cart,
          checkoutKey: null,
          lines: cart.lines.map((line) => (line === existing ? { ...line, quantity } : line)),
        };
      }
      if (cart.lines.length >= MAX_ORDER_LINES) return cart;
      const quantity = Math.min(MAX_LINE_QUANTITY, Math.max(1, Math.trunc(added.quantity)));
      return { ...cart, checkoutKey: null, lines: [...cart.lines, { ...added, quantity }] };
    }
    case "setQuantity": {
      if (!Number.isInteger(action.quantity)) return cart;
      if (action.quantity <= 0) return cartReducer(cart, { type: "remove", key: action.key });
      const quantity = Math.min(MAX_LINE_QUANTITY, action.quantity);
      const target = cart.lines.find((line) => lineKey(line) === action.key);
      if (!target || target.quantity === quantity) return cart;
      return {
        ...cart,
        checkoutKey: null,
        lines: cart.lines.map((line) => (line === target ? { ...line, quantity } : line)),
      };
    }
    case "remove": {
      const lines = cart.lines.filter((line) => lineKey(line) !== action.key);
      return lines.length === cart.lines.length ? cart : { ...cart, checkoutKey: null, lines };
    }
    case "setNote": {
      const note = action.note.slice(0, MAX_NOTE_LENGTH);
      return note === cart.note ? cart : { ...cart, note, checkoutKey: null };
    }
    case "beginCheckout":
      return cart.checkoutKey ? cart : { ...cart, checkoutKey: action.key };
    case "detailsChanged":
      return cart.checkoutKey ? { ...cart, checkoutKey: null } : cart;
    case "clear":
      return EMPTY_CART;
  }
}

export interface PricedCartLine {
  key: string;
  line: CartLine;
  /** Null when the dish, portion or an add-on is no longer offered. */
  item: OrderableItem | null;
  label: string;
  unitPricePaise: number | null;
  lineTotalPaise: number;
}

export interface PricedCart {
  lines: PricedCartLine[];
  itemCount: number;
  hasUnavailable: boolean;
  subtotalPaise: number;
}

/** Prices the cart against the menu as currently published. */
export function priceCart(cart: Cart, items: ReadonlyMap<string, OrderableItem>): PricedCart {
  let subtotalPaise = 0;
  let itemCount = 0;
  let hasUnavailable = false;
  const lines = cart.lines.map((line): PricedCartLine => {
    const item = items.get(line.itemId) ?? null;
    const unit = item ? unitPricePaise(item, line.variantId, line.addonIds) : null;
    if (unit === null) hasUnavailable = true;
    const variant = item?.variants.find((candidate) => candidate.id === line.variantId);
    const addons = line.addonIds
      .map((id) => item?.addons.find((addon) => addon.id === id)?.name)
      .filter((name): name is string => Boolean(name));
    const lineTotalPaise = unit === null ? 0 : unit * line.quantity;
    subtotalPaise += lineTotalPaise;
    itemCount += line.quantity;
    return {
      key: lineKey(line),
      line,
      item: unit === null ? null : item,
      label: [item?.name ?? "Dish no longer on the menu", variant?.name, ...addons].filter(Boolean).join(" · "),
      unitPricePaise: unit,
      lineTotalPaise,
    };
  });
  return { lines, itemCount, hasUnavailable, subtotalPaise };
}

export interface CustomerDetails {
  name: string;
  phone: string;
  fulfilment: OrderFulfilment | null;
  address: string;
  serviceArea: string;
}

export const EMPTY_DETAILS: CustomerDetails = { name: "", phone: "", fulfilment: null, address: "", serviceArea: "" };

export function parseDetails(raw: string | null): CustomerDetails {
  if (!raw) return EMPTY_DETAILS;
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (data?.v !== 1) return EMPTY_DETAILS;
  const text = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");
  return {
    name: text(data.name, 80),
    phone: text(data.phone, 20),
    fulfilment: ORDER_FULFILMENTS.includes(data.fulfilment as OrderFulfilment) ? (data.fulfilment as OrderFulfilment) : null,
    address: text(data.address, 300),
    serviceArea: text(data.serviceArea, 100),
  };
}

export function serializeDetails(details: CustomerDetails): string {
  return JSON.stringify({ v: 1, ...details });
}

export interface CheckoutCharges {
  minimumOrderPaise: number;
  deliveryFeePaise: number;
  taxEnabled: boolean;
  taxRateBps: number;
  serviceAreas: string[];
  fulfilments: OrderFulfilment[];
}

export interface CheckoutReview {
  totals: OrderTotals | null;
  fulfilment: OrderFulfilment | null;
  /** First reason the order cannot be sent yet, in the order a customer fixes them. */
  blocker: string | null;
}

/**
 * The same rules the server applies, checked before sending so the customer sees what to
 * fix. The server stays authoritative; this only avoids a pointless round trip.
 */
export function reviewCheckout(priced: PricedCart, details: CustomerDetails, charges: CheckoutCharges): CheckoutReview {
  const fulfilment =
    details.fulfilment && charges.fulfilments.includes(details.fulfilment)
      ? details.fulfilment
      : charges.fulfilments.length === 1
        ? charges.fulfilments[0]
        : null;
  const totals = fulfilment ? orderTotals(priced.subtotalPaise, { fulfilment, ...charges }) : null;
  const blocker =
    priced.lines.length === 0
      ? "Your cart is empty."
      : priced.hasUnavailable
        ? "Remove the dishes that are no longer available."
        : !fulfilment
          ? "Choose how you want your order."
          : details.name.trim().length < 2
            ? "Enter your name."
            : !/^\+?\d{10,13}$/.test(details.phone.replace(/[\s()-]/g, ""))
              ? "Enter a phone number the restaurant can call."
              : fulfilment === "delivery" && details.address.trim().length < 8
                ? "Enter your delivery address."
                : fulfilment === "delivery" && !charges.serviceAreas.includes(details.serviceArea)
                  ? "Choose your delivery area."
                  : fulfilment === "delivery" && priced.subtotalPaise < charges.minimumOrderPaise
                    ? "Your order is below the minimum for delivery."
                    : null;
  return { totals, fulfilment, blocker };
}

export interface RecentOrder {
  id: string;
  slug: string;
  restaurantName: string;
  orderNumber: number;
  placedAt: string;
}

export const MAX_RECENT_ORDERS = 10;

export function parseRecentOrders(raw: string | null): RecentOrder[] {
  if (!raw) return [];
  const data = JSON.parse(raw) as Record<string, unknown>;
  if (data?.v !== 1 || !Array.isArray(data.orders)) return [];
  return data.orders
    .filter(
      (order): order is RecentOrder =>
        !!order && typeof order === "object" &&
        typeof order.id === "string" && /^ord_[0-9a-f-]{36}$/.test(order.id) &&
        typeof order.slug === "string" && typeof order.restaurantName === "string" &&
        Number.isInteger(order.orderNumber) && typeof order.placedAt === "string"
    )
    .slice(0, MAX_RECENT_ORDERS);
}

export function serializeRecentOrders(orders: RecentOrder[]): string {
  return JSON.stringify({ v: 1, orders });
}

export function rememberOrder(orders: RecentOrder[], order: RecentOrder): RecentOrder[] {
  return [order, ...orders.filter((existing) => existing.id !== order.id)].slice(0, MAX_RECENT_ORDERS);
}

/** The checkout submission. One status at a time, so "sending" and "failed" never overlap. */
export type CheckoutFlow =
  | { status: "editing" }
  | { status: "submitting" }
  | { status: "failed"; message: string };

export type CheckoutFlowAction =
  | { type: "submit" }
  | { type: "fail"; message: string }
  | { type: "edit" };

export function checkoutFlowReducer(flow: CheckoutFlow, action: CheckoutFlowAction): CheckoutFlow {
  switch (action.type) {
    case "submit":
      return flow.status === "submitting" ? flow : { status: "submitting" };
    case "fail":
      return { status: "failed", message: action.message };
    case "edit":
      return flow.status === "failed" ? { status: "editing" } : flow;
  }
}
