import { one, rows, transaction, type Queryable } from "./pg";
import { loadPosPriceBook, type PosPriceBook } from "./posCatalog";
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

type CapturedPrices = Map<string, { itemId: string; unitPrice: number }>;

/**
 * A terminal may have been offline for a whole service, so its payload is never trusted for
 * money. A line the server already holds keeps the price it was captured at, so a menu edit
 * mid-meal never changes an open bill; a new line takes the restaurant's current price. Only
 * genuinely off-menu items keep the operator's price, within the range the terminal allows.
 */
function repriceSession(
  session: PosTableSession,
  prices: PosPriceBook,
  captured: CapturedPrices
): PosTableSession {
  const outletName = prices.outlets.get(session.outletId);
  if (outletName === undefined) {
    throw new Error(`This account cannot bill for ${session.outletName}.`);
  }
  return {
    ...session,
    // Receipts and claimed bills show this, so it comes from the restaurant, not the device.
    outletName,
    lines: session.lines.map((line) => {
      if (line.itemId.startsWith(CUSTOM_ITEM_PREFIX)) {
        const price = Math.round(line.unitPrice);
        if (!Number.isSafeInteger(price) || price < 1 || price > MAX_CUSTOM_PRICE) {
          throw new Error(`Custom dish "${line.name}" has an unusable price.`);
        }
        return { ...line, unitPrice: price };
      }
      const stored = captured.get(line.lineId);
      if (stored && stored.itemId === line.itemId) {
        return { ...line, unitPrice: stored.unitPrice };
      }
      const price = prices.priceOf(session.outletId, line.itemId);
      if (price === null) {
        throw new Error(`"${line.name}" is no longer on the menu.`);
      }
      return { ...line, unitPrice: price };
    }),
  };
}

/** Read before any table is rewritten, so lines moved by a merge or transfer keep their price. */
async function capturedLinePrices(
  client: Queryable,
  userId: string,
  lineIds: string[]
): Promise<CapturedPrices> {
  if (lineIds.length === 0) return new Map();
  const found = await client.query<Record<string, unknown>>(
    `SELECT l.line_id, l.item_id, l.unit_price FROM pos_lines l
     JOIN pos_sessions s ON s.id = l.session_id
     WHERE s.user_id = $1 AND l.line_id = ANY($2::text[])`,
    [userId, lineIds]
  );
  return new Map(
    found.rows.map((row) => [
      String(row.line_id),
      { itemId: String(row.item_id), unitPrice: Number(row.unit_price) },
    ])
  );
}

/** Thrown when a device edited a table that moved on underneath it; reloading resolves it. */
class StaleRevisionError extends Error {}

async function writeSession(
  client: Queryable,
  userId: string,
  session: PosTableSession
): Promise<void> {
  // FOR UPDATE: the revision is read and then written against, so the row must stay put
  // for the rest of this transaction.
  const existing = (
    await client.query("SELECT revision FROM pos_sessions WHERE id = $1 AND user_id = $2 FOR UPDATE", [
      session.sessionId,
      userId,
    ])
  ).rows[0] as Record<string, unknown> | undefined;

  // Optimistic concurrency: the device must have based its edit on what the server holds.
  const storedRevision = existing ? Number(existing.revision) : 0;
  if (existing && storedRevision !== session.revision) {
    throw new StaleRevisionError(
      `Table ${session.tableId} changed on another terminal. Reload before editing it again.`
    );
  }
  const revision = storedRevision + 1;

  // Lines, tickets and voids cascade from the session row, so this clears them too.
  await client.query("DELETE FROM pos_sessions WHERE id = $1 AND user_id = $2", [
    session.sessionId,
    userId,
  ]);
  await client.query(
    `INSERT INTO pos_sessions (id, user_id, shift_id, outlet_id, outlet_name, table_id, guest_count,
       server_name, opened_at, status, discount_percent, service_charge_percent, next_kot_number,
       merged_into_session_id, payment_method, payment_amount_tendered, payment_change_due,
       payment_settled_at, synced_at, revision)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
    [
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
      revision,
    ]
  );

  for (const entry of session.lines) {
    await client.query(
      `INSERT INTO pos_lines (session_id, line_id, item_id, name, unit_price, quantity, dietary, note, kot_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        session.sessionId,
        entry.lineId,
        entry.itemId,
        entry.name,
        entry.unitPrice,
        entry.quantity,
        entry.dietary,
        entry.note,
        entry.kotNumber,
      ]
    );
  }

  for (const entry of session.tickets) {
    await client.query(
      `INSERT INTO pos_tickets (session_id, kot_number, fired_at, merged_from, lines_json)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        session.sessionId,
        entry.kotNumber,
        entry.firedAt,
        entry.mergedFrom,
        JSON.stringify(entry.lines),
      ]
    );
  }

  for (const entry of session.voids) {
    await client.query(
      "INSERT INTO pos_voids (session_id, name, quantity, reason, voided_at) VALUES ($1, $2, $3, $4, $5)",
      [session.sessionId, entry.name, entry.quantity, entry.reason, entry.voidedAt]
    );
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
export async function syncPosState(userId: string, payload: unknown): Promise<PosSyncResult> {
  const body = (payload ?? {}) as Record<string, unknown>;
  const incoming = restorePosSessions(JSON.stringify(body.sessions ?? []));
  const shift = restorePosShift(JSON.stringify(body.shift ?? null));

  const rejected: PosSyncResult["rejected"] = [];
  const conflicts: PosSyncResult["conflicts"] = [];
  const prices = await loadPosPriceBook(userId);

  await transaction(async (client) => {
    await client.query("DELETE FROM pos_shifts WHERE user_id = $1", [userId]);
    const shiftOutletName = shift ? prices.outlets.get(shift.outletId) : undefined;
    // A shift at an outlet this account cannot bill for is not kept.
    if (shift && shiftOutletName !== undefined) {
      await client.query(
        `INSERT INTO pos_shifts (id, user_id, outlet_id, outlet_name, opened_by, opened_at, opening_cash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          shift.shiftId,
          userId,
          shift.outletId,
          shiftOutletName,
          shift.openedBy,
          shift.openedAt,
          shift.openingCash,
        ]
      );
    }

    const captured = await capturedLinePrices(
      client,
      userId,
      incoming.flatMap((session) => session.lines.map((line) => line.lineId))
    );
    for (const session of incoming) {
      // Each table is all-or-nothing on its own: a failure after writeSession has deleted
      // the old rows must not commit a half-written table alongside the accepted ones.
      await client.query("SAVEPOINT pos_table");
      try {
        await writeSession(client, userId, repriceSession(session, prices, captured));
        await client.query("RELEASE SAVEPOINT pos_table");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT pos_table");
        await client.query("RELEASE SAVEPOINT pos_table");
        const entry = {
          sessionId: session.sessionId,
          reason: error instanceof Error ? error.message : "Could not store this table.",
        };
        if (error instanceof StaleRevisionError) conflicts.push(entry);
        else rejected.push(entry);
      }
    }
  });

  const state = await loadPosState(userId, rejected, conflicts);
  // Only tables the server actually accepted become claimable bills.
  await recordSettledBills(state.sessions);
  for (const session of state.sessions) {
    if (session.status !== "SETTLED") continue;
    const code = await getClaimCode(session.sessionId);
    if (code) state.claimCodes[session.sessionId] = code;
  }
  return state;
}

export async function loadPosState(
  userId: string,
  rejected: PosSyncResult["rejected"] = [],
  conflicts: PosSyncResult["conflicts"] = []
): Promise<PosSyncResult> {
  const sessionRows = await rows<Record<string, unknown>>(
    "SELECT * FROM pos_sessions WHERE user_id = $1 ORDER BY opened_at LIMIT 200",
    [userId]
  );

  const ids = sessionRows.map((row) => String(row.id));
  // Three queries for the whole floor rather than three per table.
  const [allLines, allTickets, allVoids] = ids.length
    ? await Promise.all([
        rows<Record<string, unknown>>(
          "SELECT * FROM pos_lines WHERE session_id = ANY($1::text[]) ORDER BY id",
          [ids]
        ),
        rows<Record<string, unknown>>(
          "SELECT * FROM pos_tickets WHERE session_id = ANY($1::text[]) ORDER BY kot_number",
          [ids]
        ),
        rows<Record<string, unknown>>(
          "SELECT * FROM pos_voids WHERE session_id = ANY($1::text[]) ORDER BY id",
          [ids]
        ),
      ])
    : [[], [], []];

  const bucket = (source: Record<string, unknown>[]) => {
    const map = new Map<string, Record<string, unknown>[]>();
    for (const row of source) {
      const key = String(row.session_id);
      const found = map.get(key);
      if (found) found.push(row);
      else map.set(key, [row]);
    }
    return map;
  };
  const linesBy = bucket(allLines);
  const ticketsBy = bucket(allTickets);
  const voidsBy = bucket(allVoids);

  const rebuilt = sessionRows.map((row) => ({
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
    lines: (linesBy.get(String(row.id)) ?? []).map((line) => ({
      lineId: String(line.line_id),
      itemId: String(line.item_id),
      name: String(line.name),
      unitPrice: Number(line.unit_price),
      quantity: Number(line.quantity),
      dietary: String(line.dietary),
      note: String(line.note),
      kotNumber: line.kot_number === null ? null : Number(line.kot_number),
    })),
    tickets: (ticketsBy.get(String(row.id)) ?? []).map((ticket) => ({
      kotNumber: Number(ticket.kot_number),
      tableId: String(row.table_id),
      serverName: String(row.server_name),
      firedAt: String(ticket.fired_at),
      mergedFrom: ticket.merged_from === null ? null : String(ticket.merged_from),
      lines: JSON.parse(String(ticket.lines_json)),
    })),
    voids: (voidsBy.get(String(row.id)) ?? []).map((entry) => ({
      name: String(entry.name),
      quantity: Number(entry.quantity),
      reason: String(entry.reason),
      voidedAt: String(entry.voided_at),
    })),
  }));

  // Re-validate on the way out so a hand-edited row cannot reach the terminal.
  const sessions = restorePosSessions(JSON.stringify(rebuilt));
  const shiftRow = await one<Record<string, unknown>>(
    "SELECT * FROM pos_shifts WHERE user_id = $1 LIMIT 1",
    [userId]
  );

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
