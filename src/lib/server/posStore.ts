import { one, rows, transaction, type Queryable } from "./pg";
import {
  BILLABLE_RESTAURANT_SQL,
  billableOutletIds,
  loadPosPriceBook,
  type PosPriceBook,
} from "./posCatalog";
import { isRestaurantAdminEmail } from "./restaurantStore";
import {
  calculatePosBill,
  restorePosSessions,
  restorePosShift,
  type PosShift,
  type PosTableSession,
} from "@/lib/pos/posEngine";
import { getClaimCodes, recordSettledBills } from "./dineInStore";

const CUSTOM_ITEM_PREFIX = "custom_";
const MAX_CUSTOM_PRICE = 100000;

interface CapturedPrices {
  lines: Map<string, { itemId: string; unitPrice: number }>;
  taxRates: Map<string, number>;
}

/**
 * A terminal may have been offline for a whole service, so its payload is never trusted for
 * money. A line the server already holds keeps the price it was captured at, so a menu edit
 * mid-meal never changes an open bill; a new line takes the restaurant's current price. Only
 * genuinely off-menu items keep the operator's price, within the range the terminal allows.
 * The tax rate follows the same rule per table.
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
    taxRateBps: captured.taxRates.get(session.sessionId) ?? prices.taxRateOf(session.outletId),
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
      const stored = captured.lines.get(line.lineId);
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
async function capturedPrices(
  client: Queryable,
  outletIds: number[],
  sessions: PosTableSession[]
): Promise<CapturedPrices> {
  const lineIds = sessions.flatMap((session) => session.lines.map((line) => line.lineId));
  const sessionIds = sessions.map((session) => session.sessionId);
  if (sessionIds.length === 0 || outletIds.length === 0) return { lines: new Map(), taxRates: new Map() };
  // One transaction client runs one query at a time, so these go in turn.
  // Prices are shared by the outlet, not by the waiter who first rang the dish.
  const lines = await client.query<Record<string, unknown>>(
    `SELECT l.line_id, l.item_id, l.unit_price FROM pos_lines l
     JOIN pos_sessions s ON s.id = l.session_id
     WHERE s.outlet_id = ANY($1::int[]) AND l.line_id = ANY($2::text[])`,
    [outletIds, lineIds]
  );
  const tables = await client.query<Record<string, unknown>>(
    "SELECT id, tax_rate_bps FROM pos_sessions WHERE outlet_id = ANY($1::int[]) AND id = ANY($2::text[])",
    [outletIds, sessionIds]
  );
  return {
    lines: new Map(
      lines.rows.map((row) => [
        String(row.line_id),
        { itemId: String(row.item_id), unitPrice: Number(row.unit_price) },
      ])
    ),
    taxRates: new Map(tables.rows.map((row) => [String(row.id), Number(row.tax_rate_bps)])),
  };
}

/** Thrown when a device edited a table that moved on underneath it; reloading resolves it. */
class StaleRevisionError extends Error {}

async function writeSession(
  client: Queryable,
  userId: string,
  session: PosTableSession,
  allowedOutlets: ReadonlySet<number>,
  deviceId: string | null
): Promise<void> {
  // The row is deleted and re-inserted below, so a FOR UPDATE alone would let a second phone's
  // waiting save find no row once the first commits, skip the revision check and overwrite it.
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`pos-session:${session.sessionId}`]);
  // FOR UPDATE: the revision is read and then written against, so the row must stay put
  // for the rest of this transaction. The row is the outlet's, not one waiter's: any
  // teammate who can bill this outlet may add to it.
  const existing = (
    await client.query(
      "SELECT revision, bill_number, user_id, outlet_id, last_device_id FROM pos_sessions WHERE id = $1 FOR UPDATE",
      [session.sessionId]
    )
  ).rows[0] as Record<string, unknown> | undefined;

  if (existing && !allowedOutlets.has(Number(existing.outlet_id))) {
    throw new Error(`This account cannot bill for ${session.outletName}.`);
  }
  if (existing && Number(existing.outlet_id) !== session.outletId) {
    throw new Error(`Table ${session.tableId} belongs to another outlet.`);
  }

  // Optimistic concurrency: the device must have based its edit on what the server holds.
  // The one exception is this same phone retrying after its last answer was lost: nobody else
  // has written since, so its newer copy loses nothing.
  const storedRevision = existing ? Number(existing.revision) : 0;
  const ownLastWrite =
    deviceId !== null && existing?.last_device_id === deviceId && session.revision < storedRevision;
  if (existing && storedRevision !== session.revision && !ownLastWrite) {
    throw new StaleRevisionError(
      `Table ${session.tableId} changed on another terminal. Reload before editing it again.`
    );
  }
  const revision = storedRevision + 1;

  // A bill keeps its number for life, through corrections and a reopen; it is given one the
  // first time it is paid. The lock makes numbering per restaurant gapless across terminals.
  let billNumber = existing?.bill_number == null ? null : Number(existing.bill_number);
  if (billNumber === null && session.status === "SETTLED") {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`pos-bill:${session.outletId}`]);
    const next = await client.query(
      "SELECT COALESCE(MAX(bill_number), 0) + 1 AS next FROM pos_sessions WHERE outlet_id = $1",
      [session.outletId]
    );
    billNumber = Number(next.rows[0].next);
  }
  const grandTotal = session.status === "SETTLED" ? calculatePosBill(session).grandTotal : null;

  // Lines, tickets and voids cascade from the session row, so this clears them too.
  await client.query("DELETE FROM pos_sessions WHERE id = $1", [session.sessionId]);
  await client.query(
    `INSERT INTO pos_sessions (id, user_id, shift_id, outlet_id, outlet_name, table_id, guest_count,
       server_name, opened_at, status, discount_percent, service_charge_percent, next_kot_number,
       merged_into_session_id, payment_method, payment_amount_tendered, payment_change_due,
       payment_settled_at, synced_at, revision, guests_json, tax_rate_bps, corrections_json,
       bill_number, grand_total, last_device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)`,
    [
      session.sessionId,
      existing ? String(existing.user_id) : userId,
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
      JSON.stringify(session.guests),
      session.taxRateBps,
      JSON.stringify(session.corrections),
      billNumber,
      grandTotal,
      deviceId,
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
  /** Printed on the bill; given by the server the first time a bill is paid. */
  billNumbers: Record<string, number>;
}

/**
 * Push a terminal's offline queue. Each table is shared by the outlet, so this replaces only
 * the sessions it sent; tables another waiter owns are left alone rather than deleted.
 */
export async function syncPosState(userId: string, payload: unknown): Promise<PosSyncResult> {
  const body = (payload ?? {}) as Record<string, unknown>;
  const incoming = restorePosSessions(JSON.stringify(body.sessions ?? []));
  const shift = restorePosShift(JSON.stringify(body.shift ?? null));
  const deviceId =
    typeof body.device === "string" && /^[A-Za-z0-9-]{8,64}$/.test(body.device) ? body.device : null;

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

    const allowedOutlets = new Set(prices.outlets.keys());
    const captured = await capturedPrices(client, [...allowedOutlets], incoming);
    for (const session of incoming) {
      // Each table is all-or-nothing on its own: a failure after writeSession has deleted
      // the old rows must not commit a half-written table alongside the accepted ones.
      await client.query("SAVEPOINT pos_table");
      try {
        await writeSession(client, userId, repriceSession(session, prices, captured), allowedOutlets, deviceId);
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

  const outletIds = [...prices.outlets.keys()];
  // The reply is the tables this push sent, as stored now: accepted ones carry their new
  // revision, and a conflict carries the other terminal's version to show instead.
  const sent = await loadTables(
    outletIds,
    incoming.map((session) => session.sessionId)
  );
  // Only tables the server accepted from this push become claimable bills.
  const refused = new Set([...rejected, ...conflicts].map((entry) => entry.sessionId));
  const accepted = sent.sessions.filter((session) => !refused.has(session.sessionId));
  await recordSettledBills(accepted);
  return {
    sessions: sent.sessions,
    shift: await loadShift(userId),
    settledTotal: settledTotal(sent.sessions),
    rejected,
    conflicts,
    claimCodes: await getClaimCodes(
      accepted.filter((session) => session.status === "SETTLED").map((session) => session.sessionId)
    ),
    billNumbers: sent.billNumbers,
  };
}

/** JSON columns are validated again by restorePosSessions; this only has to survive bad JSON. */
function parseJsonColumn(value: unknown): unknown {
  try {
    return JSON.parse(String(value ?? "[]"));
  } catch {
    return [];
  }
}

/** Full tables, with lines, tickets and voids, for session rows read from the database. */
export async function hydrateSessions(
  sessionRows: Record<string, unknown>[]
): Promise<PosTableSession[]> {
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
    guests: parseJsonColumn(row.guests_json),
    taxRateBps: Number(row.tax_rate_bps),
    corrections: parseJsonColumn(row.corrections_json),
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
  return restorePosSessions(JSON.stringify(rebuilt));
}

function billNumbersOf(sessionRows: Record<string, unknown>[]): Record<string, number> {
  return Object.fromEntries(
    sessionRows
      .filter((row) => row.bill_number != null)
      .map((row) => [String(row.id), Number(row.bill_number)])
  );
}

function settledTotal(sessions: PosTableSession[]): number {
  return sessions
    .filter((session) => session.status === "SETTLED")
    .reduce((total, session) => total + calculatePosBill(session).grandTotal, 0);
}

async function loadShift(userId: string): Promise<PosShift | null> {
  const shiftRow = await one<Record<string, unknown>>(
    "SELECT * FROM pos_shifts WHERE user_id = $1 LIMIT 1",
    [userId]
  );
  return shiftRow
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
    : null;
}

async function loadTables(
  outletIds: number[],
  ids: string[]
): Promise<{ sessions: PosTableSession[]; billNumbers: Record<string, number> }> {
  if (outletIds.length === 0 || ids.length === 0) return { sessions: [], billNumbers: {} };
  const sessionRows = await rows<Record<string, unknown>>(
    `SELECT * FROM pos_sessions
     WHERE outlet_id = ANY($1::int[]) AND id = ANY($2::text[])
     ORDER BY opened_at`,
    [outletIds, ids]
  );
  return { sessions: await hydrateSessions(sessionRows), billNumbers: billNumbersOf(sessionRows) };
}

/** Everything a terminal needs when it starts: the shared floor, recent bills and its shift. */
export async function loadPosState(userId: string): Promise<PosSyncResult> {
  // Open tables belong to the outlet, so every waiter who can bill it sees the same floor.
  // Older closed bills are read through listSalesHistory instead.
  const outletIds = await billableOutletIds(userId);
  const sessionRows =
    outletIds.length === 0
      ? []
      : await rows<Record<string, unknown>>(
          `SELECT * FROM (
             SELECT * FROM pos_sessions
             WHERE outlet_id = ANY($1::int[]) AND status = 'OPEN'
             UNION
             (SELECT * FROM pos_sessions
              WHERE outlet_id = ANY($1::int[]) AND status <> 'OPEN'
              ORDER BY COALESCE(payment_settled_at, opened_at) DESC LIMIT 100)
           ) AS floor ORDER BY opened_at`,
          [outletIds]
        );
  const sessions = await hydrateSessions(sessionRows);

  return {
    sessions,
    shift: await loadShift(userId),
    settledTotal: settledTotal(sessions),
    rejected: [],
    conflicts: [],
    claimCodes: {},
    billNumbers: billNumbersOf(sessionRows),
  };
}

/** The open tables of every outlet this account bills for, as `pos_sessions s`. */
const SHARED_OPEN_TABLES_SQL = `pos_sessions s
  WHERE s.status = 'OPEN'
    AND s.outlet_id IN (SELECT r.pos_outlet_id FROM managed_restaurants r WHERE ${BILLABLE_RESTAURANT_SQL})`;

export interface FloorVersion {
  /** Changes whenever any shared table is opened, edited or closed. */
  version: string;
  /** `[sessionId, revision]` of every open table; only sent when `version` moved. */
  heads?: [string, number][];
}

/**
 * What a terminal polls every few seconds, so it costs one small row while nothing changes,
 * however many tables or bills the restaurant has. When the version moved, the open tables'
 * revisions come back too, and the terminal fetches only the tables it is behind on.
 */
export async function loadFloorVersion(
  user: { id: string; email: string },
  since: string | null
): Promise<FloorVersion> {
  const row = await one<{ version: string; heads: unknown }>(
    `SELECT floor.version, CASE WHEN floor.version IS DISTINCT FROM $3::text THEN floor.heads END AS heads
     FROM (
       SELECT md5(COALESCE(string_agg(s.id || ':' || s.revision, ',' ORDER BY s.id), '')) AS version,
              COALESCE(json_agg(json_build_array(s.id, s.revision) ORDER BY s.id), '[]'::json) AS heads
       FROM ${SHARED_OPEN_TABLES_SQL}
     ) AS floor`,
    [user.id, isRestaurantAdminEmail(user.email), since]
  );
  const version = String(row?.version ?? "");
  const heads = row?.heads;
  if (!Array.isArray(heads)) return { version };
  return {
    version,
    heads: heads.flatMap((head: unknown): [string, number][] =>
      Array.isArray(head) && typeof head[0] === "string" && Number.isSafeInteger(head[1])
        ? [[head[0], head[1] as number]]
        : []
    ),
  };
}

/** Shared tables by id, for a terminal that is behind on them; any status, any waiter. */
export async function loadFloorTables(
  user: { id: string; email: string },
  ids: string[]
): Promise<{ sessions: PosTableSession[]; billNumbers: Record<string, number> }> {
  if (ids.length === 0) return { sessions: [], billNumbers: {} };
  const sessionRows = await rows<Record<string, unknown>>(
    `SELECT s.* FROM pos_sessions s
     WHERE s.id = ANY($3::text[])
       AND s.outlet_id IN (SELECT r.pos_outlet_id FROM managed_restaurants r WHERE ${BILLABLE_RESTAURANT_SQL})
     ORDER BY s.opened_at`,
    [user.id, isRestaurantAdminEmail(user.email), ids]
  );
  return { sessions: await hydrateSessions(sessionRows), billNumbers: billNumbersOf(sessionRows) };
}
