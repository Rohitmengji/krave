import { getDb } from "./db";
import { withdrawUnstartedTicket } from "./kitchenStore";
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
export function saveOrder(
  userId: string,
  order: CrystalOrderState,
  input: { addressId: string; idempotencyKey: string | null }
): void {
  const db = getDb();
  db.exec("BEGIN");
  try {
    db.prepare(
      `INSERT INTO orders (id, user_id, res_id, address_id, payment_method, coupon_code,
         is_gold_member, rider_tip, scheduled_slot, due_at, stage, grand_total, placed_at,
         idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
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
      input.idempotencyKey
    );

    const line = db.prepare(
      `INSERT INTO order_lines (order_id, item_id, quantity, option_ids, cooking_instruction)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const item of order.items) {
      line.run(
        order.orderId,
        item.item.id,
        item.quantity,
        JSON.stringify(item.selectedOptions.map((option) => option.id)),
        item.cookingInstruction ?? null
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function findOrderByIdempotencyKey(
  userId: string,
  idempotencyKey: string | null
): CrystalOrderState | null {
  if (!idempotencyKey) return null;
  const row = getDb()
    .prepare("SELECT id FROM orders WHERE user_id = ? AND idempotency_key = ?")
    .get(userId, idempotencyKey) as Record<string, unknown> | undefined;
  if (!row) return null;
  return listOrders(userId).find((order) => order.orderId === String(row.id)) ?? null;
}

export function listOrders(userId: string): CrystalOrderState[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM orders WHERE user_id = ? ORDER BY placed_at DESC LIMIT 50")
    .all(userId) as Record<string, unknown>[];
  const lineStatement = db.prepare("SELECT * FROM order_lines WHERE order_id = ? ORDER BY id");

  return rows.flatMap((row): CrystalOrderState[] => {
    const lines = lineStatement.all(String(row.id)) as Record<string, unknown>[];
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

export function advanceOrderStage(userId: string, orderId: string, stage: string): void {
  const result = getDb()
    .prepare("UPDATE orders SET stage = ? WHERE id = ? AND user_id = ?")
    .run(stage, orderId, userId);
  if (result.changes === 0) {
    throw new Error("That order is not in your history.");
  }
}

export function deleteOrder(userId: string, orderId: string): void {
  const db = getDb();
  // The order and its kitchen ticket go together, or neither does.
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare("SELECT stage FROM orders WHERE id = ? AND user_id = ?")
      .get(orderId, userId) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error("That order is no longer in your history.");
    }
    if (String(row.stage) !== "ORDER_CONFIRMED" || !withdrawUnstartedTicket(orderId)) {
      throw new Error("This order has already reached the kitchen and cannot be cancelled.");
    }
    db.prepare("DELETE FROM orders WHERE id = ? AND user_id = ?").run(orderId, userId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function saveReservation(userId: string, reservation: DiningReservation): void {
  getDb()
    .prepare(
      `INSERT INTO reservations (id, user_id, res_id, date, time_slot, guests, guest_name,
         guest_phone, special_request, offer_applied, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
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
      reservation.createdAt
    );
}

/**
 * Whether this account has actually eaten here — an order placed, or a booking made.
 * Used to decide if a review may carry a "verified" badge, so the badge means something.
 */
export function hasVisited(userId: string, resId: number): boolean {
  if (!Number.isSafeInteger(resId)) return false;

  const row = getDb()
    .prepare(
      `SELECT
         EXISTS(SELECT 1 FROM orders WHERE user_id = ? AND res_id = ?) AS ordered,
         EXISTS(SELECT 1 FROM reservations WHERE user_id = ? AND res_id = ?) AS booked`
    )
    .get(userId, resId, userId, resId) as Record<string, unknown>;

  return Number(row.ordered) === 1 || Number(row.booked) === 1;
}

export function listReservations(userId: string): DiningReservation[] {
  const rows = getDb()
    .prepare("SELECT * FROM reservations WHERE user_id = ? ORDER BY created_at DESC LIMIT 30")
    .all(userId) as Record<string, unknown>[];

  return rows.flatMap((row): DiningReservation[] => {
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

export function listBookmarks(userId: string): number[] {
  return (
    getDb()
      .prepare("SELECT res_id FROM bookmarks WHERE user_id = ?")
      .all(userId) as Record<string, unknown>[]
  ).map((row) => Number(row.res_id));
}

/**
 * Start any scheduled order whose window has arrived. There is no background scheduler
 * here, so this runs on the next request after the due time rather than exactly at it.
 */
export function sweepScheduledOrders(userId: string): string[] {
  const db = getDb();
  const due = db
    .prepare(
      `SELECT id, scheduled_slot FROM orders
       WHERE user_id = ? AND stage = 'ORDER_CONFIRMED' AND due_at <= ?`
    )
    .all(userId, new Date().toISOString()) as Record<string, unknown>[];
  if (due.length === 0) return [];

  const advance = db.prepare("UPDATE orders SET stage = 'KITCHEN_PREPARING' WHERE id = ?");
  const started: string[] = [];
  for (const row of due) {
    const orderId = String(row.id);
    // An ASAP order is due the moment it is placed; announcing that adds nothing.
    if (String(row.scheduled_slot) !== "ASAP") {
      addNotification(
        userId,
        "ORDER",
        "Your scheduled order has started",
        `The kitchen began your ${String(row.scheduled_slot)} order.`
      );
    }
    advance.run(orderId);
    started.push(orderId);
  }
  return started;
}

export function addNotification(
  userId: string,
  kind: KraveNotificationKind,
  title: string,
  body: string
): KraveNotification {
  const entry = createNotification(kind, title, body);
  getDb()
    .prepare(
      "INSERT INTO notifications (id, user_id, kind, title, body, created_at, read_at) VALUES (?, ?, ?, ?, ?, ?, NULL)"
    )
    .run(entry.id, userId, entry.kind, entry.title, entry.body, entry.createdAt);
  return entry;
}

export function listNotifications(userId: string): KraveNotification[] {
  return (
    getDb()
      .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 40")
      .all(userId) as Record<string, unknown>[]
  ).map((row) => ({
    id: String(row.id),
    kind: String(row.kind) as KraveNotificationKind,
    title: String(row.title),
    body: String(row.body),
    createdAt: String(row.created_at),
    read: row.read_at !== null,
  }));
}

export function markNotificationsRead(userId: string): void {
  getDb()
    .prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL")
    .run(new Date().toISOString(), userId);
}

export function clearNotifications(userId: string): void {
  getDb().prepare("DELETE FROM notifications WHERE user_id = ?").run(userId);
}

export function setBookmarks(userId: string, resIds: unknown): number[] {
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

  const db = getDb();
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM bookmarks WHERE user_id = ?").run(userId);
    const insert = db.prepare("INSERT INTO bookmarks (user_id, res_id) VALUES (?, ?)");
    for (const resId of known) insert.run(userId, resId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return known;
}
