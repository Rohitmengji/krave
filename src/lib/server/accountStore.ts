import { one, rows, run, transaction, type Queryable } from "./pg";
import { createDeliveryTicket } from "./kitchenStore";
import {
  createDemoOrder,
  createNotification,
  createValidatedReservation,
  ORDER_STAGES,
  scheduledDueAt,
  type KraveNotification,
  type KraveNotificationKind,
} from "@/lib/checkout";
import { RESTAURANTS_DATA } from "@/data/zomatoReconstructedData";
import type { CrystalOrderState, DiningReservation } from "@/types/krave";

/**
 * Orders are stored as the inputs that produced them, never as client totals. Reading an
 * order replays it through the same validator the API uses, so a row cannot inflate a price.
 */
/**
 * Writes the order row and its lines on the caller's transaction.
 *
 * Returns false, having written nothing, when this user already has an order under the
 * same idempotency key. The partial unique index decides, so two concurrent retries of
 * one checkout cannot both get through a check-then-insert.
 */
async function insertOrder(
  client: Queryable,
  userId: string,
  order: CrystalOrderState,
  input: { addressId: string; idempotencyKey: string | null }
): Promise<boolean> {
  const inserted = await client.query(
    `INSERT INTO orders (id, user_id, res_id, address_id, payment_method, coupon_code,
       is_gold_member, rider_tip, scheduled_slot, due_at, stage, grand_total, placed_at,
       idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING`,
    [
      order.orderId,
      userId,
      order.resId,
      input.addressId,
      order.paymentMethod,
      order.quote.couponCode,
      order.quote.deliveryFee === 0 ? 1 : 0,
      order.quote.riderTip,
      order.scheduledSlot,
      scheduledDueAt(order.scheduledSlot, order.placedAt).toISOString(),
      order.stage,
      order.quote.grandTotal,
      order.placedAt,
      input.idempotencyKey,
    ]
  );
  if (inserted.rowCount === 0) return false;

  for (const item of order.items) {
    await client.query(
      `INSERT INTO order_lines (order_id, item_id, quantity, option_ids, cooking_instruction)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        order.orderId,
        item.item.id,
        item.quantity,
        JSON.stringify(item.selectedOptions.map((option) => option.id)),
        item.cookingInstruction ?? null,
      ]
    );
  }
  return true;
}

export async function saveOrder(
  userId: string,
  order: CrystalOrderState,
  input: { addressId: string; idempotencyKey: string | null }
): Promise<boolean> {
  return transaction((client) => insertOrder(client, userId, order, input));
}

/**
 * A signed-in checkout: the order, its kitchen ticket and the confirmation commit together.
 *
 * Returns false when the idempotency key was already used; nothing is written then, so a
 * retry can never leave a second ticket in the kitchen.
 */
export async function placeOrder(
  userId: string,
  order: CrystalOrderState,
  input: { addressId: string; idempotencyKey: string | null },
  confirmation: { title: string; body: string }
): Promise<boolean> {
  return transaction(async (client) => {
    if (!(await insertOrder(client, userId, order, input))) return false;
    await createDeliveryTicket(order, client);
    await insertNotification(client, userId, createNotification("ORDER", confirmation.title, confirmation.body));
    return true;
  });
}

export async function findOrderByIdempotencyKey(
  userId: string,
  idempotencyKey: string | null
): Promise<CrystalOrderState | null> {
  if (!idempotencyKey) return null;
  const row = await one<Record<string, unknown>>(
    "SELECT id FROM orders WHERE user_id = $1 AND idempotency_key = $2",
    [userId, idempotencyKey]
  );
  if (!row) return null;
  const orders = await listOrders(userId);
  return orders.find((order) => order.orderId === String(row.id)) ?? null;
}

export async function listOrders(userId: string): Promise<CrystalOrderState[]> {
  const found = await rows<Record<string, unknown>>(
    "SELECT * FROM orders WHERE user_id = $1 ORDER BY placed_at DESC LIMIT 50",
    [userId]
  );
  if (found.length === 0) return [];

  // One query for every line rather than one per order: each round trip costs network now.
  const allLines = await rows<Record<string, unknown>>(
    "SELECT * FROM order_lines WHERE order_id = ANY($1::text[]) ORDER BY id",
    [found.map((row) => String(row.id))]
  );
  const linesByOrder = new Map<string, Record<string, unknown>[]>();
  for (const line of allLines) {
    const key = String(line.order_id);
    const bucket = linesByOrder.get(key);
    if (bucket) bucket.push(line);
    else linesByOrder.set(key, [line]);
  }

  return found.flatMap((row): CrystalOrderState[] => {
    const lines = linesByOrder.get(String(row.id)) ?? [];
    const stage = ORDER_STAGES.find((candidate) => candidate === row.stage);
    if (!stage) return [];
    try {
      const rebuilt = createDemoOrder({
        addressId: String(row.address_id),
        paymentMethod: String(row.payment_method),
        couponCode: row.coupon_code === null ? null : String(row.coupon_code),
        isGoldMember: Number(row.is_gold_member) === 1,
        riderTip: Number(row.rider_tip),
        scheduledSlot: String(row.scheduled_slot),
        items: lines.map((line) => ({
          itemId: String(line.item_id),
          quantity: Number(line.quantity),
          optionIds: JSON.parse(String(line.option_ids)) as string[],
          cookingInstruction:
            line.cooking_instruction === null ? undefined : String(line.cooking_instruction),
        })),
      });
      return [{ ...rebuilt, orderId: String(row.id), placedAt: String(row.placed_at), stage }];
    } catch {
      // A catalog change can orphan an old row; drop it rather than failing the whole list.
      return [];
    }
  });
}

/**
 * Moves an order forward to `stage`. Skipping ahead is allowed; moving back is not.
 *
 * Tracking updates are fire-and-forget from the browser, so they can arrive out of order.
 * A late "KITCHEN_PREPARING" after "ARRIVED" is therefore a no-op rather than an error,
 * and a backwards move can never reopen the cancel window.
 */
export async function advanceOrderStage(
  userId: string,
  orderId: string,
  stage: string
): Promise<void> {
  const target = ORDER_STAGES.findIndex((candidate) => candidate === stage);
  if (target === -1) throw new Error("Provide a known stage.");
  const found = await one<Record<string, unknown>>(
    "SELECT 1 FROM orders WHERE id = $1 AND user_id = $2",
    [orderId, userId]
  );
  if (!found) {
    throw new Error("That order is not in your history.");
  }
  await run(
    `UPDATE orders SET stage = $1
     WHERE id = $2 AND user_id = $3 AND array_position($4::text[], stage) < $5`,
    [stage, orderId, userId, [...ORDER_STAGES], target + 1]
  );
}

export async function deleteOrder(userId: string, orderId: string): Promise<void> {
  // The order and its kitchen ticket go together, or neither does.
  await transaction(async (client) => {
    const found = await client.query(
      "SELECT stage FROM orders WHERE id = $1 AND user_id = $2 FOR UPDATE",
      [orderId, userId]
    );
    const row = found.rows[0];
    if (!row) {
      throw new Error("That order is no longer in your history.");
    }
    if (String(row.stage) !== "ORDER_CONFIRMED") {
      throw new Error("This order has already reached the kitchen and cannot be cancelled.");
    }

    // Reads the ticket on this same connection, so the check and the delete cannot be
    // separated by another request accepting the ticket in between.
    const ticket = await client.query(
      "SELECT status FROM delivery_tickets WHERE order_id = $1 FOR UPDATE",
      [orderId]
    );
    if (ticket.rows[0] && String(ticket.rows[0].status) !== "NEW") {
      throw new Error("This order has already reached the kitchen and cannot be cancelled.");
    }
    await client.query("DELETE FROM delivery_tickets WHERE order_id = $1 AND status = 'NEW'", [
      orderId,
    ]);
    await client.query("DELETE FROM orders WHERE id = $1 AND user_id = $2", [orderId, userId]);
  });
}

export async function saveReservation(
  userId: string,
  reservation: DiningReservation
): Promise<void> {
  await run(
    `INSERT INTO reservations (id, user_id, res_id, date, time_slot, guests, guest_name,
       guest_phone, special_request, offer_applied, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      reservation.bookingId,
      userId,
      reservation.resId,
      reservation.date,
      reservation.timeSlot,
      reservation.guests,
      reservation.guestName,
      reservation.guestPhone,
      reservation.specialRequest,
      reservation.offerApplied,
      reservation.createdAt,
    ]
  );
}

/**
 * Whether this account has actually eaten here — an order placed, or a booking made.
 * Used to decide if a review may carry a "verified" badge, so the badge means something.
 */
export async function hasVisited(userId: string, resId: number): Promise<boolean> {
  if (!Number.isSafeInteger(resId)) return false;

  const row = await one<Record<string, unknown>>(
    `SELECT
       EXISTS(SELECT 1 FROM orders WHERE user_id = $1 AND res_id = $2) AS ordered,
       EXISTS(SELECT 1 FROM reservations WHERE user_id = $1 AND res_id = $2) AS booked`,
    [userId, resId]
  );

  return row?.ordered === true || row?.booked === true;
}

export async function listReservations(userId: string): Promise<DiningReservation[]> {
  const found = await rows<Record<string, unknown>>(
    "SELECT * FROM reservations WHERE user_id = $1 ORDER BY created_at DESC LIMIT 30",
    [userId]
  );

  return found.flatMap((row): DiningReservation[] => {
    try {
      const validated = createValidatedReservation({
        resId: Number(row.res_id),
        date: String(row.date),
        timeSlot: String(row.time_slot),
        guests: Number(row.guests),
        guestName: String(row.guest_name),
        guestPhone: String(row.guest_phone),
        specialRequest: String(row.special_request),
      });
      return [
        {
          ...validated,
          bookingId: String(row.id),
          offerApplied: String(row.offer_applied),
          createdAt: String(row.created_at),
        },
      ];
    } catch {
      return [];
    }
  });
}

export async function listBookmarks(userId: string): Promise<number[]> {
  const found = await rows<Record<string, unknown>>(
    "SELECT res_id FROM bookmarks WHERE user_id = $1",
    [userId]
  );
  return found.map((row) => Number(row.res_id));
}

/**
 * Start any scheduled order whose window has arrived. There is no background scheduler
 * here, so this runs on the next request after the due time rather than exactly at it.
 */
export async function sweepScheduledOrders(userId: string): Promise<string[]> {
  const due = await rows<Record<string, unknown>>(
    `SELECT id, scheduled_slot FROM orders
     WHERE user_id = $1 AND stage = 'ORDER_CONFIRMED' AND due_at <= $2`,
    [userId, new Date().toISOString()]
  );
  if (due.length === 0) return [];

  const started: string[] = [];
  // The stage change and its announcement commit together, so a failure cannot leave an
  // order started silently (it would never be announced, being no longer due).
  await transaction(async (client) => {
    for (const row of due) {
      const orderId = String(row.id);
      // Conditional on the stage so that when two requests sweep the same order (two tabs,
      // or two server processes), only the one whose UPDATE changed the row announces it.
      const advanced = await client.query(
        "UPDATE orders SET stage = 'KITCHEN_PREPARING' WHERE id = $1 AND stage = 'ORDER_CONFIRMED'",
        [orderId]
      );
      if (advanced.rowCount === 0) continue;

      // An ASAP order is due the moment it is placed; announcing that adds nothing.
      if (String(row.scheduled_slot) !== "ASAP") {
        const entry = createNotification(
          "ORDER",
          "Your scheduled order has started",
          `The kitchen began your ${String(row.scheduled_slot)} order.`
        );
        await client.query(
          `INSERT INTO notifications (id, user_id, kind, title, body, created_at, read_at)
           VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
          [entry.id, userId, entry.kind, entry.title, entry.body, entry.createdAt]
        );
      }
      started.push(orderId);
    }
  });
  return started;
}

export async function addNotification(
  userId: string,
  kind: KraveNotificationKind,
  title: string,
  body: string
): Promise<KraveNotification> {
  const entry = createNotification(kind, title, body);
  await insertNotification(null, userId, entry);
  return entry;
}

async function insertNotification(
  client: Queryable | null,
  userId: string,
  entry: KraveNotification
): Promise<void> {
  const sql = `INSERT INTO notifications (id, user_id, kind, title, body, created_at, read_at)
     VALUES ($1, $2, $3, $4, $5, $6, NULL)`;
  const params = [entry.id, userId, entry.kind, entry.title, entry.body, entry.createdAt];
  if (client) await client.query(sql, params);
  else await run(sql, params);
}

export async function listNotifications(userId: string): Promise<KraveNotification[]> {
  const found = await rows<Record<string, unknown>>(
    "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 40",
    [userId]
  );
  return found.map((row) => ({
    id: String(row.id),
    kind: String(row.kind) as KraveNotificationKind,
    title: String(row.title),
    body: String(row.body),
    createdAt: String(row.created_at),
    read: row.read_at !== null,
  }));
}

export async function markNotificationsRead(userId: string): Promise<void> {
  await run("UPDATE notifications SET read_at = $1 WHERE user_id = $2 AND read_at IS NULL", [
    new Date().toISOString(),
    userId,
  ]);
}

export async function clearNotifications(userId: string): Promise<void> {
  await run("DELETE FROM notifications WHERE user_id = $1", [userId]);
}

export async function setBookmarks(userId: string, resIds: unknown): Promise<number[]> {
  if (!Array.isArray(resIds)) {
    throw new Error("Bookmarks must be a list of restaurant IDs.");
  }
  const known = [
    ...new Set(
      resIds.filter(
        (id): id is number =>
          typeof id === "number" && RESTAURANTS_DATA.some((r) => r.resId === id)
      )
    ),
  ].slice(0, 200);

  await transaction(async (client) => {
    await client.query("DELETE FROM bookmarks WHERE user_id = $1", [userId]);
    if (known.length > 0) {
      await client.query(
        "INSERT INTO bookmarks (user_id, res_id) SELECT $1, * FROM UNNEST($2::int[])",
        [userId, known]
      );
    }
  });
  return known;
}
