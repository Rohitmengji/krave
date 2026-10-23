import { one, rows, run } from "./pg";
import { assertOutletStaff } from "./staff";
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
export async function createDeliveryTicket(order: CrystalOrderState): Promise<void> {
  const lines: DeliveryTicketLine[] = order.items.map((line) => ({
    name: line.item.name,
    quantity: line.quantity,
    options: line.selectedOptions.map((option) => option.name),
    note: line.cookingInstruction ?? "",
    allergens: line.item.allergens ?? null,
  }));

  await run(
    `INSERT INTO delivery_tickets (order_id, outlet_id, placed_at, scheduled_slot, due_at,
       flags, allergy_note, lines_json, status, accepted_at, ready_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'NEW', NULL, NULL)
     ON CONFLICT (order_id) DO NOTHING`,
    [
      order.orderId,
      order.resId,
      order.placedAt,
      order.scheduledSlot,
      scheduledDueAt(order.scheduledSlot, order.placedAt).toISOString(),
      JSON.stringify(order.handling.flags),
      order.handling.allergyNote,
      JSON.stringify(lines),
    ]
  );
}

export async function listDeliveryTickets(outletId: number): Promise<DeliveryTicket[]> {
  const found = await rows<Record<string, unknown>>(
    `SELECT * FROM delivery_tickets WHERE outlet_id = $1
     ORDER BY CASE status WHEN 'NEW' THEN 0 WHEN 'ACCEPTED' THEN 1 ELSE 2 END, due_at
     LIMIT 100`,
    [outletId]
  );
  return found.map(toTicket);
}

/**
 * Move a ticket forward one step. Only forward: a ticket cannot un-ready itself, because
 * the timestamps it leaves behind are what prep-time measurement is built on.
 */
export async function advanceDeliveryTicket(
  actorId: string,
  orderId: unknown,
  next: unknown
): Promise<DeliveryTicket> {
  if (typeof orderId !== "string" || !TICKET_STATUSES.some((status) => status === next)) {
    throw new Error("Provide a ticket and a known status.");
  }
  const row = await one<Record<string, unknown>>(
    "SELECT * FROM delivery_tickets WHERE order_id = $1",
    [orderId]
  );
  if (!row) {
    throw new Error("That ticket is not on this counter.");
  }

  // Checked here, not at the route, so no later caller can reach it unauthorised.
  await assertOutletStaff(actorId, Number(row.outlet_id));

  const current = TICKET_STATUSES.indexOf(String(row.status) as TicketStatus);
  const target = TICKET_STATUSES.indexOf(next as TicketStatus);
  if (target !== current + 1) {
    throw new Error(`A ticket moves from ${row.status} one step at a time.`);
  }

  const now = new Date().toISOString();
  // Guarded on the status it was read at, so two counters racing cannot both advance it.
  const changed = await run(
    `UPDATE delivery_tickets
     SET status = $1, accepted_at = COALESCE(accepted_at, $2), ready_at = $3
     WHERE order_id = $4 AND status = $5`,
    [
      next as string,
      next === "ACCEPTED" ? now : null,
      next === "READY" ? now : (row.ready_at as string | null),
      orderId,
      String(row.status),
    ]
  );
  if (changed === 0) {
    throw new Error("That ticket moved on before this change landed. Reload the counter.");
  }

  return toTicket(
    (await one<Record<string, unknown>>(
      "SELECT * FROM delivery_tickets WHERE order_id = $1",
      [orderId]
    ))!
  );
}

/**
 * Takes a cancelled order off the counter if nobody has accepted it yet. Returns false once
 * the kitchen has accepted it, because cooking may already be under way. An order with no
 * ticket has nothing to withdraw.
 */
export async function withdrawUnstartedTicket(orderId: string): Promise<boolean> {
  const row = await one<Record<string, unknown>>(
    "SELECT status FROM delivery_tickets WHERE order_id = $1",
    [orderId]
  );
  if (!row) return true;
  if (String(row.status) !== "NEW") return false;
  await run("DELETE FROM delivery_tickets WHERE order_id = $1 AND status = 'NEW'", [orderId]);
  return true;
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
export async function prepTimeStats(
  outletId: number,
  minimumSample = 5
): Promise<PrepTimeStats> {
  const found = await rows<Record<string, unknown>>(
    `SELECT accepted_at, ready_at FROM delivery_tickets
     WHERE outlet_id = $1 AND status = 'READY' AND accepted_at IS NOT NULL
     ORDER BY ready_at DESC LIMIT 100`,
    [outletId]
  );

  const durations = found
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
