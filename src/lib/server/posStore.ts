import { getDb } from "./db";
import { findDishAcrossRestaurants } from "@/lib/cartEngine";
import {
  calculatePosBill,
  restorePosSessions,
  restorePosShift,
  type PosShift,
  type PosTableSession,
} from "@/lib/pos/posEngine";
import { getClaimCode, recordSettledBills } from "./dineInStore";

const CUSTOM_ITEM_PREFIX = "custom_";
const MAX_CUSTOM_PRICE = 100000;

/**
 * A terminal may have been offline for a whole service, so its payload is never trusted for
 * money. Catalog dishes are repriced from the catalog; only genuinely off-menu items keep the
 * operator's price, and then only within the range the terminal itself allows.
 */
function repriceSession(session: PosTableSession): PosTableSession {
  return {
    ...session,
    lines: session.lines.map((line) => {
      if (line.itemId.startsWith(CUSTOM_ITEM_PREFIX)) {
        const price = Math.round(line.unitPrice);
        if (!Number.isSafeInteger(price) || price < 1 || price > MAX_CUSTOM_PRICE) {
          throw new Error(`Custom dish "${line.name}" has an unusable price.`);
        }
        return { ...line, unitPrice: price };
      }
      const found = findDishAcrossRestaurants(line.itemId);
      if (!found) {
        throw new Error(`"${line.name}" is no longer on any menu.`);
      }
      return { ...line, unitPrice: Math.round(found.dish.price) };
    }),
  };
}

/** Thrown when a device edited a table that moved on underneath it; reloading resolves it. */
class StaleRevisionError extends Error {}

function writeSession(userId: string, session: PosTableSession): void {
  const db = getDb();
  const existing = db
    .prepare("SELECT revision FROM pos_sessions WHERE id = ? AND user_id = ?")
    .get(session.sessionId, userId) as Record<string, unknown> | undefined;

  // Optimistic concurrency: the device must have based its edit on what the server holds.
  const storedRevision = existing ? Number(existing.revision) : 0;
  if (existing && storedRevision !== session.revision) {
    throw new StaleRevisionError(
      `Table ${session.tableId} changed on another terminal. Reload before editing it again.`
    );
  }
  const revision = storedRevision + 1;

  db.prepare("DELETE FROM pos_sessions WHERE id = ? AND user_id = ?").run(session.sessionId, userId);
  db.prepare(
    `INSERT INTO pos_sessions (id, user_id, shift_id, outlet_id, outlet_name, table_id, guest_count,
       server_name, opened_at, status, discount_percent, service_charge_percent, next_kot_number,
       merged_into_session_id, payment_method, payment_amount_tendered, payment_change_due,
       payment_settled_at, synced_at, revision)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    session.sessionId,
    userId,
    session.shiftId,
    session.outletId,
    session.outletName,
    session.tableId,
    session.guestCount,
    session.serverName,
    session.openedAt,
    session.status,
    session.discountPercent,
    session.serviceChargePercent,
    session.nextKotNumber,
    session.mergedIntoSessionId,
    session.payment?.method ?? null,
    session.payment?.amountTendered ?? null,
    session.payment?.changeDue ?? null,
    session.payment?.settledAt ?? null,
    new Date().toISOString(),
    revision
  );

  const line = db.prepare(
    `INSERT INTO pos_lines (session_id, line_id, item_id, name, unit_price, quantity, dietary, note, kot_number)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const entry of session.lines) {
    line.run(
      session.sessionId,
      entry.lineId,
      entry.itemId,
      entry.name,
      entry.unitPrice,
      entry.quantity,
      entry.dietary,
      entry.note,
      entry.kotNumber
    );
  }

  const ticket = db.prepare(
    `INSERT INTO pos_tickets (session_id, kot_number, fired_at, merged_from, lines_json)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const entry of session.tickets) {
    ticket.run(
      session.sessionId,
      entry.kotNumber,
      entry.firedAt,
      entry.mergedFrom,
      JSON.stringify(entry.lines)
    );
  }

  const voided = db.prepare(
    "INSERT INTO pos_voids (session_id, name, quantity, reason, voided_at) VALUES (?, ?, ?, ?, ?)"
  );
  for (const entry of session.voids) {
    voided.run(session.sessionId, entry.name, entry.quantity, entry.reason, entry.voidedAt);
  }
}

export interface PosSyncResult {
  sessions: PosTableSession[];
  shift: PosShift | null;
  /** Totals the server computed, so a terminal can show what was actually banked. */
  settledTotal: number;
  /** Recoverable: another terminal moved first, so this device should reload and redo. */
  conflicts: { sessionId: string; reason: string }[];
  /** Not recoverable by reloading: the table cannot be stored as sent. */
  rejected: { sessionId: string; reason: string }[];
  /** Printed on the receipt so a guest can attach the bill to their own account. */
  claimCodes: Record<string, string>;
}

/**
 * Push a terminal's offline queue. The device is the only writer, so this is a full replace of
 * the sessions it sent; sessions it no longer knows about are left alone rather than deleted.
 */
export function syncPosState(userId: string, payload: unknown): PosSyncResult {
  const body = (payload ?? {}) as Record<string, unknown>;
  const incoming = restorePosSessions(JSON.stringify(body.sessions ?? []));
  const shift = restorePosShift(JSON.stringify(body.shift ?? null));

  const db = getDb();
  const rejected: PosSyncResult["rejected"] = [];
  const conflicts: PosSyncResult["conflicts"] = [];
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM pos_shifts WHERE user_id = ?").run(userId);
    if (shift) {
      db.prepare(
        `INSERT INTO pos_shifts (id, user_id, outlet_id, outlet_name, opened_by, opened_at, opening_cash)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        shift.shiftId,
        userId,
        shift.outletId,
        shift.outletName,
        shift.openedBy,
        shift.openedAt,
        shift.openingCash
      );
    }

    for (const session of incoming) {
      try {
        writeSession(userId, repriceSession(session));
      } catch (error) {
        const entry = {
          sessionId: session.sessionId,
          reason: error instanceof Error ? error.message : "Could not store this table.",
        };
        if (error instanceof StaleRevisionError) conflicts.push(entry);
        else rejected.push(entry);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const state = loadPosState(userId, rejected, conflicts);
  // Only tables the server actually accepted become claimable bills.
  recordSettledBills(state.sessions);
  for (const session of state.sessions) {
    if (session.status !== "SETTLED") continue;
    const code = getClaimCode(session.sessionId);
    if (code) state.claimCodes[session.sessionId] = code;
  }
  return state;
}

export function loadPosState(
  userId: string,
  rejected: PosSyncResult["rejected"] = [],
  conflicts: PosSyncResult["conflicts"] = []
): PosSyncResult {
  const db = getDb();
  const rows = db
    .prepare("SELECT * FROM pos_sessions WHERE user_id = ? ORDER BY opened_at LIMIT 200")
    .all(userId) as Record<string, unknown>[];

  const lineStatement = db.prepare("SELECT * FROM pos_lines WHERE session_id = ? ORDER BY id");
  const ticketStatement = db.prepare("SELECT * FROM pos_tickets WHERE session_id = ? ORDER BY kot_number");
  const voidStatement = db.prepare("SELECT * FROM pos_voids WHERE session_id = ? ORDER BY id");

  const rebuilt = rows.map((row) => ({
    sessionId: String(row.id),
    outletId: Number(row.outlet_id),
    outletName: String(row.outlet_name),
    tableId: String(row.table_id),
    guestCount: Number(row.guest_count),
    serverName: String(row.server_name),
    openedAt: String(row.opened_at),
    status: String(row.status),
    discountPercent: Number(row.discount_percent),
    serviceChargePercent: Number(row.service_charge_percent),
    nextKotNumber: Number(row.next_kot_number),
    shiftId: row.shift_id === null ? null : String(row.shift_id),
    mergedIntoSessionId:
      row.merged_into_session_id === null ? null : String(row.merged_into_session_id),
    revision: Number(row.revision),
    payment:
      row.payment_method === null
        ? null
        : {
            method: String(row.payment_method),
            amountTendered: Number(row.payment_amount_tendered),
            changeDue: Number(row.payment_change_due),
            settledAt: String(row.payment_settled_at),
          },
    lines: (lineStatement.all(String(row.id)) as Record<string, unknown>[]).map((line) => ({
      lineId: String(line.line_id),
      itemId: String(line.item_id),
      name: String(line.name),
      unitPrice: Number(line.unit_price),
      quantity: Number(line.quantity),
      dietary: String(line.dietary),
      note: String(line.note),
      kotNumber: line.kot_number === null ? null : Number(line.kot_number),
    })),
    tickets: (ticketStatement.all(String(row.id)) as Record<string, unknown>[]).map((ticket) => ({
      kotNumber: Number(ticket.kot_number),
      tableId: String(row.table_id),
      serverName: String(row.server_name),
      firedAt: String(ticket.fired_at),
      mergedFrom: ticket.merged_from === null ? null : String(ticket.merged_from),
      lines: JSON.parse(String(ticket.lines_json)),
    })),
    voids: (voidStatement.all(String(row.id)) as Record<string, unknown>[]).map((entry) => ({
      name: String(entry.name),
      quantity: Number(entry.quantity),
      reason: String(entry.reason),
      voidedAt: String(entry.voided_at),
    })),
  }));

  // Re-validate on the way out so a hand-edited row cannot reach the terminal.
  const sessions = restorePosSessions(JSON.stringify(rebuilt));
  const shiftRow = db
    .prepare("SELECT * FROM pos_shifts WHERE user_id = ? LIMIT 1")
    .get(userId) as Record<string, unknown> | undefined;

  return {
    sessions,
    shift: shiftRow
      ? restorePosShift(
          JSON.stringify({
            shiftId: String(shiftRow.id),
            outletId: Number(shiftRow.outlet_id),
            outletName: String(shiftRow.outlet_name),
            openedBy: String(shiftRow.opened_by),
            openedAt: String(shiftRow.opened_at),
            openingCash: Number(shiftRow.opening_cash),
          })
        )
      : null,
    settledTotal: sessions
      .filter((session) => session.status === "SETTLED")
      .reduce((total, session) => total + calculatePosBill(session).grandTotal, 0),
    rejected,
    conflicts,
    claimCodes: {},
  };
}
