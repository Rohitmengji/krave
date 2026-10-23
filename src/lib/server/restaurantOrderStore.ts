import { createHash, randomUUID } from "node:crypto";
import type { Queryable } from "./pg";
import { one, rows, transaction } from "./pg";
import { assertCanManageRestaurant, getOpeningHours, mapRestaurant, type ManagedRestaurant } from "./restaurantStore";
import {
  ACTIVE_ORDER_STATUSES,
  customerCanCancel,
  FULFILMENT_LABELS,
  isWithinOpeningHours,
  MAX_ADDONS_PER_LINE,
  MAX_LINE_QUANTITY,
  MAX_ORDER_LINES,
  MAX_ORDER_TOTAL_PAISE,
  ORDER_FULFILMENTS,
  orderTotals,
  OWNER_ORDER_TRANSITIONS,
  unitPricePaise,
  type OrderFulfilment,
  type OrderTotals,
  type RestaurantOrderStatus,
} from "@/lib/managedOrders";

/** Errors a customer can act on. The API maps each code to a status and shows the message. */
export class OrderRequestError extends Error {
  constructor(
    readonly code: "invalid" | "closed" | "unavailable" | "price_changed" | "conflict" | "not_found",
    message: string,
    readonly quote?: OrderTotals
  ) {
    super(message);
    this.name = "OrderRequestError";
  }
}

export interface RestaurantOrderLine {
  lineNo: number;
  menuItemId: string;
  variantId: string | null;
  itemName: string;
  variantName: string | null;
  addons: { id: string; name: string; pricePaise: number }[];
  unitPricePaise: number;
  quantity: number;
  lineTotalPaise: number;
}

export interface RestaurantOrder {
  id: string;
  restaurantId: string;
  orderNumber: number;
  customerName: string;
  customerPhone: string;
  fulfilment: OrderFulfilment;
  deliveryAddress: string | null;
  serviceArea: string | null;
  note: string;
  subtotalPaise: number;
  deliveryFeePaise: number;
  taxRateBps: number;
  taxPaise: number;
  totalPaise: number;
  paymentMethod: "pay_at_restaurant" | "pay_on_delivery";
  status: RestaurantOrderStatus;
  statusReason: string | null;
  placedAt: string;
  updatedAt: string;
  lines: RestaurantOrderLine[];
}

/** What the customer's status page shows: no phone number or address. */
export interface PublicRestaurantOrder {
  id: string;
  orderNumber: number;
  restaurant: { name: string; slug: string; phone: string | null };
  fulfilment: OrderFulfilment;
  subtotalPaise: number;
  deliveryFeePaise: number;
  taxPaise: number;
  totalPaise: number;
  paymentMethod: RestaurantOrder["paymentMethod"];
  status: RestaurantOrderStatus;
  statusReason: string | null;
  placedAt: string;
  updatedAt: string;
  lines: RestaurantOrderLine[];
}

type Row = Record<string, unknown>;

const ORDER_ID = /^ord_[0-9a-f-]{36}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,100}$/;

function str(value: unknown): string {
  return value == null ? "" : String(value);
}

function mapLine(row: Row): RestaurantOrderLine {
  const addons = Array.isArray(row.addons) ? (row.addons as Row[]) : [];
  return {
    lineNo: Number(row.line_no),
    menuItemId: str(row.menu_item_id),
    variantId: row.variant_id == null ? null : str(row.variant_id),
    itemName: str(row.item_name),
    variantName: row.variant_name == null ? null : str(row.variant_name),
    addons: addons.map((addon) => ({ id: str(addon.id), name: str(addon.name), pricePaise: Number(addon.pricePaise) })),
    unitPricePaise: Number(row.unit_price_paise),
    quantity: Number(row.quantity),
    lineTotalPaise: Number(row.line_total_paise),
  };
}

function mapOrder(row: Row, lines: RestaurantOrderLine[]): RestaurantOrder {
  return {
    id: str(row.id),
    restaurantId: str(row.restaurant_id),
    orderNumber: Number(row.order_number),
    customerName: str(row.customer_name),
    customerPhone: str(row.customer_phone),
    fulfilment: str(row.fulfilment) as OrderFulfilment,
    deliveryAddress: row.delivery_address == null ? null : str(row.delivery_address),
    serviceArea: row.service_area == null ? null : str(row.service_area),
    note: str(row.note),
    subtotalPaise: Number(row.subtotal_paise),
    deliveryFeePaise: Number(row.delivery_fee_paise),
    taxRateBps: Number(row.tax_rate_bps),
    taxPaise: Number(row.tax_paise),
    totalPaise: Number(row.total_paise),
    paymentMethod: str(row.payment_method) as RestaurantOrder["paymentMethod"],
    status: str(row.status) as RestaurantOrderStatus,
    statusReason: row.status_reason == null ? null : str(row.status_reason),
    placedAt: str(row.placed_at),
    updatedAt: str(row.updated_at),
    lines,
  };
}

async function linesFor(orderIds: string[], client?: Queryable): Promise<Map<string, RestaurantOrderLine[]>> {
  const byOrder = new Map<string, RestaurantOrderLine[]>();
  if (!orderIds.length) return byOrder;
  const sql = "SELECT * FROM restaurant_order_lines WHERE order_id = ANY($1::text[]) ORDER BY order_id, line_no";
  const found = client ? (await client.query<Row>(sql, [orderIds])).rows : await rows<Row>(sql, [orderIds]);
  for (const row of found) {
    const id = str(row.order_id);
    byOrder.set(id, [...(byOrder.get(id) ?? []), mapLine(row)]);
  }
  return byOrder;
}

// ---------------------------------------------------------------------------------------
// Input validation. Everything from the request body is untrusted.

interface RequestedLine {
  itemId: string;
  variantId: string | null;
  addonIds: string[];
  quantity: number;
}

interface OrderRequest {
  slug: string;
  idempotencyKey: string;
  customerName: string;
  customerPhone: string;
  fulfilment: OrderFulfilment;
  deliveryAddress: string | null;
  serviceArea: string | null;
  note: string;
  lines: RequestedLine[];
  expectedTotalPaise: number;
}

function invalid(message: string): never {
  throw new OrderRequestError("invalid", message);
}

function boundedText(value: unknown, label: string, min: number, max: number): string {
  if (typeof value !== "string") invalid(`${label} is required.`);
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length < min || normalized.length > max) {
    invalid(min > 0 ? `${label} must be ${min}–${max} characters.` : `${label} must be at most ${max} characters.`);
  }
  return normalized;
}

function idText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 100) invalid(`${label} is invalid.`);
  return value;
}

/** Indian mobile or landline: 10–13 digits once spaces, dashes and a leading + are removed. */
export function normalizePhone(value: unknown): string {
  if (typeof value !== "string") invalid("Enter a phone number the restaurant can call.");
  const compact = value.replace(/[\s()-]/g, "");
  if (!/^\+?\d{10,13}$/.test(compact)) invalid("Enter a phone number the restaurant can call.");
  return compact;
}

export function parseOrderRequest(slug: string, input: unknown): OrderRequest {
  const body = (input ?? {}) as Record<string, unknown>;
  if (typeof body.idempotencyKey !== "string" || !IDEMPOTENCY_KEY.test(body.idempotencyKey)) {
    invalid("Refresh the page and try again.");
  }
  const fulfilment = body.fulfilment;
  if (typeof fulfilment !== "string" || !ORDER_FULFILMENTS.includes(fulfilment as OrderFulfilment)) {
    invalid("Choose takeaway, dine-in or delivery.");
  }
  const isDelivery = fulfilment === "delivery";
  if (!Array.isArray(body.lines) || body.lines.length === 0) invalid("Your cart is empty.");
  if (body.lines.length > MAX_ORDER_LINES) invalid(`An order may have at most ${MAX_ORDER_LINES} lines.`);
  const lines = body.lines.map((raw): RequestedLine => {
    const line = (raw ?? {}) as Record<string, unknown>;
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_LINE_QUANTITY) {
      invalid(`Each dish's quantity must be between 1 and ${MAX_LINE_QUANTITY}.`);
    }
    const addonIds = line.addonIds ?? [];
    if (!Array.isArray(addonIds) || addonIds.length > MAX_ADDONS_PER_LINE) invalid("Add-ons are invalid.");
    return {
      itemId: idText(line.itemId, "Dish"),
      variantId: line.variantId == null ? null : idText(line.variantId, "Portion"),
      addonIds: addonIds.map((id) => idText(id, "Add-on")),
      quantity,
    };
  });
  const expectedTotalPaise = Number(body.expectedTotalPaise);
  if (!Number.isSafeInteger(expectedTotalPaise) || expectedTotalPaise < 0) invalid("Refresh the page and try again.");
  return {
    slug,
    idempotencyKey: body.idempotencyKey,
    customerName: boundedText(body.customerName, "Name", 2, 80),
    customerPhone: normalizePhone(body.customerPhone),
    fulfilment: fulfilment as OrderFulfilment,
    deliveryAddress: isDelivery ? boundedText(body.deliveryAddress, "Delivery address", 8, 300) : null,
    serviceArea: isDelivery ? boundedText(body.serviceArea, "Delivery area", 1, 100) : null,
    note: body.note == null ? "" : boundedText(body.note, "Note", 0, 300),
    lines,
    expectedTotalPaise,
  };
}

/** Fingerprint of what was asked for, so a reused key with a different cart is refused. */
function requestHash(request: OrderRequest): string {
  const canonical = {
    customerName: request.customerName,
    customerPhone: request.customerPhone,
    fulfilment: request.fulfilment,
    deliveryAddress: request.deliveryAddress,
    serviceArea: request.serviceArea,
    note: request.note,
    lines: request.lines.map((line) => ({ ...line, addonIds: [...line.addonIds].sort() })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ---------------------------------------------------------------------------------------
// Ordering rules that depend on the restaurant.

export interface OrderingState {
  open: boolean;
  /** Why ordering is unavailable, for the customer; null when open. */
  reason: string | null;
  fulfilments: OrderFulfilment[];
}

export function orderingState(restaurant: ManagedRestaurant, hours: Parameters<typeof isWithinOpeningHours>[0], at = new Date()): OrderingState {
  const fulfilments = ORDER_FULFILMENTS.filter((option) =>
    option === "delivery"
      ? restaurant.deliveryEnabled && restaurant.serviceAreas.length > 0
      : option === "takeaway"
        ? restaurant.takeawayEnabled
        : restaurant.dineInEnabled
  );
  if (restaurant.status !== "published" || !restaurant.acceptingOrders) {
    return { open: false, reason: "Online ordering is paused. Please call the restaurant.", fulfilments };
  }
  if (!isWithinOpeningHours(hours, at, restaurant.timeZone)) {
    return { open: false, reason: "The restaurant is closed right now.", fulfilments };
  }
  if (fulfilments.length === 0) {
    return { open: false, reason: "Online ordering is not set up yet. Please call the restaurant.", fulfilments };
  }
  return { open: true, reason: null, fulfilments };
}

// ---------------------------------------------------------------------------------------
// Placing an order.

export interface PlacedOrder {
  order: PublicRestaurantOrder;
  /** True when this request repeated an earlier one with the same key. */
  replayed: boolean;
}

async function existingByKey(client: Queryable, restaurantId: string, request: OrderRequest): Promise<string | null> {
  const found = await client.query<Row>(
    "SELECT id, request_hash FROM restaurant_orders WHERE restaurant_id = $1 AND idempotency_key = $2",
    [restaurantId, request.idempotencyKey]
  );
  const row = found.rows[0];
  if (!row) return null;
  if (str(row.request_hash) !== requestHash(request)) {
    throw new OrderRequestError("conflict", "This checkout was already used for a different order. Refresh and try again.");
  }
  return str(row.id);
}

export async function placeRestaurantOrder(
  slug: string,
  input: unknown,
  customerUserId: string | null,
  now = new Date()
): Promise<PlacedOrder> {
  const request = parseOrderRequest(slug, input);
  const restaurantRow = await one<Row>("SELECT * FROM managed_restaurants WHERE slug = $1 AND status = 'published'", [slug]);
  if (!restaurantRow) throw new OrderRequestError("not_found", "This restaurant is not taking orders here.");
  const restaurant = mapRestaurant(restaurantRow);

  const orderId = await transaction(async (client) => {
    // One order placement at a time per restaurant: this serialises a double-submitted
    // checkout (so the second sees the first's key) and allocates the order number.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`restaurant-order:${restaurant.id}`]);
    const replay = await existingByKey(client, restaurant.id, request);
    if (replay) return { id: replay, replayed: true };

    // Re-read inside the lock, so a switch-off or menu edit that just committed applies.
    const fresh = await client.query<Row>("SELECT * FROM managed_restaurants WHERE id = $1", [restaurant.id]);
    const current = mapRestaurant(fresh.rows[0]);
    const state = orderingState(current, await getOpeningHours(current.id, client), now);
    if (!state.open) throw new OrderRequestError("closed", state.reason ?? "Ordering is closed.");
    if (!state.fulfilments.includes(request.fulfilment)) {
      throw new OrderRequestError("closed", `${FULFILMENT_LABELS[request.fulfilment]} is not available right now.`);
    }
    if (request.fulfilment === "delivery" && !current.serviceAreas.includes(request.serviceArea ?? "")) {
      throw new OrderRequestError("invalid", "Choose one of the listed delivery areas.");
    }

    const itemIds = [...new Set(request.lines.map((line) => line.itemId))];
    const items = await client.query<Row>(
      `SELECT i.id, i.name, i.price_paise, i.discounted_price_paise
       FROM menu_items i
       JOIN menu_categories c ON c.id = i.category_id AND c.restaurant_id = i.restaurant_id
       WHERE i.restaurant_id = $1 AND i.id = ANY($2::text[])
         AND i.published = 1 AND i.available = 1 AND c.visible = 1`,
      [current.id, itemIds]
    );
    const variants = await client.query<Row>(
      `SELECT id, item_id, name, price_delta_paise FROM menu_item_variants
       WHERE restaurant_id = $1 AND item_id = ANY($2::text[]) AND available = 1`,
      [current.id, itemIds]
    );
    const addons = await client.query<Row>(
      `SELECT id, item_id, name, price_paise FROM menu_item_addons
       WHERE restaurant_id = $1 AND item_id = ANY($2::text[]) AND available = 1`,
      [current.id, itemIds]
    );
    const itemById = new Map(items.rows.map((row) => [str(row.id), row]));

    const priced = request.lines.map((line, index) => {
      const item = itemById.get(line.itemId);
      if (!item) {
        throw new OrderRequestError("unavailable", "A dish in your cart is no longer available. Your cart has been updated.");
      }
      const itemVariants = variants.rows.filter((row) => str(row.item_id) === line.itemId);
      const itemAddons = addons.rows.filter((row) => str(row.item_id) === line.itemId);
      const unit = unitPricePaise(
        {
          pricePaise: Number(item.price_paise),
          discountedPricePaise: item.discounted_price_paise == null ? null : Number(item.discounted_price_paise),
          variants: itemVariants.map((row) => ({ id: str(row.id), priceDeltaPaise: Number(row.price_delta_paise) })),
          addons: itemAddons.map((row) => ({ id: str(row.id), pricePaise: Number(row.price_paise) })),
        },
        line.variantId,
        line.addonIds
      );
      if (unit === null) {
        throw new OrderRequestError(
          "unavailable",
          `A portion or add-on for ${str(item.name)} is no longer available. Your cart has been updated.`
        );
      }
      const variant = itemVariants.find((row) => str(row.id) === line.variantId);
      return {
        line_no: index + 1,
        menu_item_id: line.itemId,
        variant_id: line.variantId,
        item_name: str(item.name),
        variant_name: variant ? str(variant.name) : null,
        addons: line.addonIds.map((id) => {
          const addon = itemAddons.find((row) => str(row.id) === id)!;
          return { id, name: str(addon.name), pricePaise: Number(addon.price_paise) };
        }),
        unit_price_paise: unit,
        quantity: line.quantity,
        line_total_paise: unit * line.quantity,
      };
    });

    const subtotal = priced.reduce((sum, line) => sum + line.line_total_paise, 0);
    const totals = orderTotals(subtotal, {
      fulfilment: request.fulfilment,
      deliveryFeePaise: current.deliveryFeePaise,
      taxEnabled: current.taxEnabled,
      taxRateBps: current.taxRateBps,
    });
    if (subtotal <= 0) invalid("Your cart is empty.");
    if (totals.totalPaise > MAX_ORDER_TOTAL_PAISE) {
      invalid("This order is too large to place online. Please call the restaurant.");
    }
    if (request.fulfilment === "delivery" && subtotal < current.minimumOrderPaise) {
      invalid("Your order is below the minimum for delivery.");
    }
    if (totals.totalPaise !== request.expectedTotalPaise) {
      throw new OrderRequestError(
        "price_changed",
        "Prices or charges changed since you opened the menu. Review the new total and place the order again.",
        totals
      );
    }

    const numbered = await client.query<{ next: number }>(
      "SELECT COALESCE(MAX(order_number), 0) + 1 AS next FROM restaurant_orders WHERE restaurant_id = $1",
      [current.id]
    );
    const id = `ord_${randomUUID()}`;
    const placedAt = now.toISOString();
    await client.query(
      `INSERT INTO restaurant_orders
       (id, restaurant_id, order_number, idempotency_key, request_hash, customer_user_id,
        customer_name, customer_phone, fulfilment, delivery_address, service_area, note,
        subtotal_paise, delivery_fee_paise, tax_rate_bps, tax_paise, total_paise,
        payment_method, status, placed_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
               'placed', $19, $19)`,
      [
        id, current.id, Number(numbered.rows[0].next), request.idempotencyKey, requestHash(request),
        customerUserId, request.customerName, request.customerPhone, request.fulfilment,
        request.deliveryAddress, request.serviceArea, request.note, totals.subtotalPaise,
        totals.deliveryFeePaise, current.taxEnabled ? current.taxRateBps : 0, totals.taxPaise,
        totals.totalPaise, request.fulfilment === "delivery" ? "pay_on_delivery" : "pay_at_restaurant",
        placedAt,
      ]
    );
    await client.query(
      `INSERT INTO restaurant_order_lines
       (order_id, line_no, menu_item_id, variant_id, item_name, variant_name, addons,
        unit_price_paise, quantity, line_total_paise)
       SELECT $1, l.line_no, l.menu_item_id, l.variant_id, l.item_name, l.variant_name,
              COALESCE(l.addons, '[]'::jsonb), l.unit_price_paise, l.quantity, l.line_total_paise
       FROM jsonb_to_recordset($2::jsonb) AS l(
         line_no smallint, menu_item_id text, variant_id text, item_name text, variant_name text,
         addons jsonb, unit_price_paise integer, quantity integer, line_total_paise integer)`,
      [id, JSON.stringify(priced)]
    );
    return { id, replayed: false };
  });

  const order = await getPublicRestaurantOrder(orderId.id);
  if (!order) throw new Error("The order was saved but could not be read back.");
  return { order, replayed: orderId.replayed };
}

// ---------------------------------------------------------------------------------------
// Reading and changing orders.

export async function getPublicRestaurantOrder(orderId: string): Promise<PublicRestaurantOrder | null> {
  if (!ORDER_ID.test(orderId)) return null;
  const row = await one<Row>(
    `SELECT o.*, r.name AS restaurant_name, r.slug AS restaurant_slug, r.phone AS restaurant_phone
     FROM restaurant_orders o JOIN managed_restaurants r ON r.id = o.restaurant_id
     WHERE o.id = $1`,
    [orderId]
  );
  if (!row) return null;
  const order = mapOrder(row, (await linesFor([orderId])).get(orderId) ?? []);
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    restaurant: {
      name: str(row.restaurant_name),
      slug: str(row.restaurant_slug),
      phone: row.restaurant_phone == null ? null : str(row.restaurant_phone),
    },
    fulfilment: order.fulfilment,
    subtotalPaise: order.subtotalPaise,
    deliveryFeePaise: order.deliveryFeePaise,
    taxPaise: order.taxPaise,
    totalPaise: order.totalPaise,
    paymentMethod: order.paymentMethod,
    status: order.status,
    statusReason: order.statusReason,
    placedAt: order.placedAt,
    updatedAt: order.updatedAt,
    lines: order.lines,
  };
}

/** The customer withdraws an order the restaurant has not yet accepted. */
export async function cancelOrderByCustomer(orderId: string): Promise<PublicRestaurantOrder> {
  if (!ORDER_ID.test(orderId)) throw new OrderRequestError("not_found", "Order not found.");
  const updated = await one<Row>(
    `UPDATE restaurant_orders
     SET status = 'cancelled', status_reason = 'Cancelled by the customer', updated_at = $2
     WHERE id = $1 AND status = 'placed' RETURNING id`,
    [orderId, new Date().toISOString()]
  );
  const order = await getPublicRestaurantOrder(orderId);
  if (!order) throw new OrderRequestError("not_found", "Order not found.");
  if (!updated && !customerCanCancel(order.status)) {
    // Repeating a cancel that already happened is not an error.
    if (order.status === "cancelled") return order;
    throw new OrderRequestError(
      "conflict",
      "The restaurant has already accepted this order. Please call them to change it."
    );
  }
  return order;
}

export type OrderListView = "active" | "done" | "all";

export interface OrderPage {
  orders: RestaurantOrder[];
  /** Pass back as `before` to load the next, older page; null at the end. */
  nextCursor: string | null;
}

export async function listRestaurantOrders(
  userId: string,
  restaurantId: string,
  options: { view?: OrderListView; before?: string | null; limit?: number } = {}
): Promise<OrderPage> {
  await assertCanManageRestaurant(userId, restaurantId);
  const view = options.view ?? "active";
  const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);
  const params: unknown[] = [restaurantId];
  let where = "restaurant_id = $1";
  if (view !== "all") {
    params.push([...ACTIVE_ORDER_STATUSES]);
    where += view === "active" ? ` AND status = ANY($${params.length}::text[])` : ` AND NOT (status = ANY($${params.length}::text[]))`;
  }
  if (options.before) {
    const [placedAt, id] = options.before.split("|");
    if (!placedAt || !id || !ORDER_ID.test(id)) throw new Error("The page cursor is invalid.");
    params.push(placedAt, id);
    where += ` AND (placed_at, id) < ($${params.length - 1}, $${params.length})`;
  }
  params.push(limit + 1);
  const found = await rows<Row>(
    `SELECT * FROM restaurant_orders WHERE ${where} ORDER BY placed_at DESC, id DESC LIMIT $${params.length}`,
    params
  );
  const page = found.slice(0, limit);
  const lines = await linesFor(page.map((row) => str(row.id)));
  const orders = page.map((row) => mapOrder(row, lines.get(str(row.id)) ?? []));
  const last = orders.at(-1);
  return { orders, nextCursor: found.length > limit && last ? `${last.placedAt}|${last.id}` : null };
}

export const ORDER_CHANGED =
  "This order was updated on another device. The latest status has been loaded.";

export async function changeRestaurantOrderStatus(
  userId: string,
  restaurantId: string,
  input: unknown
): Promise<RestaurantOrder> {
  await assertCanManageRestaurant(userId, restaurantId);
  const body = (input ?? {}) as Record<string, unknown>;
  const orderId = typeof body.orderId === "string" && ORDER_ID.test(body.orderId) ? body.orderId : invalid("Order not found.");
  const from = body.from as RestaurantOrderStatus;
  const to = body.to as RestaurantOrderStatus;
  if (typeof from !== "string" || !Object.hasOwn(OWNER_ORDER_TRANSITIONS, from) || !OWNER_ORDER_TRANSITIONS[from].includes(to)) {
    invalid("That status change is not allowed.");
  }
  const reason =
    to === "rejected" || to === "cancelled"
      ? body.reason == null || body.reason === ""
        ? null
        : boundedText(body.reason, "Reason", 0, 200)
      : null;
  const now = new Date().toISOString();
  return transaction(async (client) => {
    // Applies only from the status the owner saw, so two devices cannot both move it.
    const updated = await client.query<Row>(
      `UPDATE restaurant_orders
       SET status = $4, status_reason = $5, status_changed_by = $6, updated_at = $7
       WHERE id = $1 AND restaurant_id = $2 AND status = $3 RETURNING *`,
      [orderId, restaurantId, from, to, reason, userId, now]
    );
    if (!updated.rowCount) {
      const exists = await client.query("SELECT 1 FROM restaurant_orders WHERE id = $1 AND restaurant_id = $2", [
        orderId,
        restaurantId,
      ]);
      if (!exists.rowCount) throw new OrderRequestError("not_found", "Order not found.");
      throw new OrderRequestError("conflict", ORDER_CHANGED);
    }
    await client.query(
      `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, detail, created_at)
       VALUES ($1, $2, 'ORDER_STATUS_CHANGED', $3, $4::jsonb, $5)`,
      [restaurantId, userId, orderId, JSON.stringify({ from, to }), now]
    );
    const lines = await linesFor([orderId], client);
    return mapOrder(updated.rows[0], lines.get(orderId) ?? []);
  });
}

/** Status code for each customer-facing failure. */
export function orderErrorStatus(error: OrderRequestError): number {
  switch (error.code) {
    case "invalid":
      return 400;
    case "not_found":
      return 404;
    case "closed":
    case "unavailable":
    case "price_changed":
    case "conflict":
      return 409;
  }
}
