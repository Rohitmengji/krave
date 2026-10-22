import { getDb } from "./db";
import { isCriticalFlag, scheduledDueAt, type KitchenFlagId } from "@/lib/checkout";
import type { CrystalOrderState } from "@/types/krave";

export const TICKET_STATUSES = ["NEW", "ACCEPTED", "READY"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export interface DeliveryTicketLine {
  name: string;
  quantity: number;
  options: string[];
  note: string;
  /** null means the kitchen never declared allergens for this dish, which is not "none". */
  allergens: string[] | null;
}

export interface DeliveryTicket {
  orderId: string;
  outletId: number;
  placedAt: string;
  scheduledSlot: string;
  dueAt: string;
  flags: KitchenFlagId[];
  allergyNote: string;
  /** True when something on this ticket must be read before cooking starts. */
  critical: boolean;
  lines: DeliveryTicketLine[];
  status: TicketStatus;
  acceptedAt: string | null;
  readyAt: string | null;
  /** Minutes from accepting to ready; null until the ticket is finished. */
  prepMinutes: number | null;
}

function toTicket(row: Record<string, unknown>): DeliveryTicket {
  const flags = JSON.parse(String(row.flags)) as KitchenFlagId[];
  const acceptedAt = row.accepted_at === null ? null : String(row.accepted_at);
  const readyAt = row.ready_at === null ? null : String(row.ready_at);

  return {
    orderId: String(row.order_id),
    outletId: Number(row.outlet_id),
    placedAt: String(row.placed_at),
    scheduledSlot: String(row.scheduled_slot),
    dueAt: String(row.due_at),
    flags,
    allergyNote: String(row.allergy_note),
    critical: flags.some(isCriticalFlag),
    lines: JSON.parse(String(row.lines_json)) as DeliveryTicketLine[],
    status: String(row.status) as TicketStatus,
    acceptedAt,
    readyAt,
    prepMinutes:
      acceptedAt && readyAt
        ? Math.round((Date.parse(readyAt) - Date.parse(acceptedAt)) / 60000)
        : null,
  };
}

/** Project a placed order onto the outlet's counter. Idempotent per order. */
export function createDeliveryTicket(order: CrystalOrderState): void {
  const lines: DeliveryTicketLine[] = order.items.map((line) => ({
    name: line.item.name,
    quantity: line.quantity,
    options: line.selectedOptions.map((option) => option.name),
    note: line.cookingInstruction ?? "",
    allergens: line.item.allergens ?? null,
  }));

  getDb()
    .prepare(
      `INSERT INTO delivery_tickets (order_id, outlet_id, placed_at, scheduled_slot, due_at,
         flags, allergy_note, lines_json, status, accepted_at, ready_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'NEW', NULL, NULL)
       ON CONFLICT(order_id) DO NOTHING`
    )
    .run(
      order.orderId,
      order.resId,
      order.placedAt,
      order.scheduledSlot,
      scheduledDueAt(order.scheduledSlot, order.placedAt).toISOString(),
      JSON.stringify(order.handling.flags),
      order.handling.allergyNote,
      JSON.stringify(lines)
    );
}

export function listDeliveryTickets(outletId: number): DeliveryTicket[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM delivery_tickets WHERE outlet_id = ?
         ORDER BY CASE status WHEN 'NEW' THEN 0 WHEN 'ACCEPTED' THEN 1 ELSE 2 END, due_at
         LIMIT 100`
      )
      .all(outletId) as Record<string, unknown>[]
  ).map(toTicket);
}

/**
 * Move a ticket forward one step. Only forward: a ticket cannot un-ready itself, because
 * the timestamps it leaves behind are what prep-time measurement is built on.
 */
export function advanceDeliveryTicket(orderId: unknown, next: unknown): DeliveryTicket {
  if (typeof orderId !== "string" || !TICKET_STATUSES.some((status) => status === next)) {
    throw new Error("Provide a ticket and a known status.");
  }
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM delivery_tickets WHERE order_id = ?")
    .get(orderId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error("That ticket is not on this counter.");
  }

  const current = TICKET_STATUSES.indexOf(String(row.status) as TicketStatus);
  const target = TICKET_STATUSES.indexOf(next as TicketStatus);
  if (target !== current + 1) {
    throw new Error(`A ticket moves from ${row.status} one step at a time.`);
  }

  const now = new Date().toISOString();
  db.prepare(
    `UPDATE delivery_tickets
     SET status = ?, accepted_at = COALESCE(accepted_at, ?), ready_at = ?
     WHERE order_id = ?`
  ).run(
    next as string,
    next === "ACCEPTED" ? now : null,
    next === "READY" ? now : (row.ready_at as string | null),
    orderId
  );

  return toTicket(
    db.prepare("SELECT * FROM delivery_tickets WHERE order_id = ?").get(orderId) as Record<
      string,
      unknown
    >
  );
}

export interface PrepTimeStats {
  sampleSize: number;
  medianMinutes: number | null;
  p90Minutes: number | null;
}

/**
 * Measured prep time from the counter's own timestamps. Reported as a median and a 90th
 * percentile rather than one padded number, and only once there are enough samples for it
 * to mean anything.
 */
export function prepTimeStats(outletId: number, minimumSample = 5): PrepTimeStats {
  const durations = (
    getDb()
      .prepare(
        `SELECT accepted_at, ready_at FROM delivery_tickets
         WHERE outlet_id = ? AND status = 'READY' AND accepted_at IS NOT NULL
         ORDER BY ready_at DESC LIMIT 100`
      )
      .all(outletId) as Record<string, unknown>[]
  )
    .map((row) => (Date.parse(String(row.ready_at)) - Date.parse(String(row.accepted_at))) / 60000)
    .filter((minutes) => Number.isFinite(minutes) && minutes >= 0)
    .sort((a, b) => a - b);

  if (durations.length < minimumSample) {
    return { sampleSize: durations.length, medianMinutes: null, p90Minutes: null };
  }

  const at = (fraction: number) =>
    Math.round(durations[Math.min(durations.length - 1, Math.floor(durations.length * fraction))]);

  return { sampleSize: durations.length, medianMinutes: at(0.5), p90Minutes: at(0.9) };
}
