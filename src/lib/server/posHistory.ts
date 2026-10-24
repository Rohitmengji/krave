import { calculatePosBill, type PosPaymentMethod, type PosTableSession } from "@/lib/pos/posEngine";
import { rows, run } from "./pg";
import { billableOutletName } from "./posCatalog";
import { hydrateSessions } from "./posStore";

const PAGE_SIZE = 40;
const MAX_RANGE_DAYS = 400;
const MAX_QUERY_LENGTH = 60;

export interface SalesHistoryEntry {
  session: PosTableSession;
  billNumber: number | null;
  grandTotal: number;
  /** The receipt's claim code, so a reprint can carry it too. */
  claimCode: string | null;
}

export interface SalesHistory {
  outletName: string;
  /** For the whole period, whatever the search. */
  summary: { bills: number; total: number; byMethod: Record<PosPaymentMethod, number> };
  entries: SalesHistoryEntry[];
  /** Pass back as `before` for the next page; null when there is nothing older. */
  nextCursor: string | null;
}

export class SalesHistoryAccessError extends Error {}

function isoParam(value: unknown, label: string): string {
  const text = typeof value === "string" ? value : "";
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new Error(`Give a valid ${label} date.`);
  return new Date(time).toISOString();
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Totals are stored when a bill is synced. Bills synced before that column existed get theirs
 * the first time a period containing them is opened.
 */
async function fillMissingTotals(outletId: number, from: string, to: string): Promise<void> {
  const missing = await rows<Record<string, unknown>>(
    `SELECT * FROM pos_sessions
     WHERE outlet_id = $1 AND status = 'SETTLED' AND grand_total IS NULL
       AND payment_settled_at >= $2 AND payment_settled_at < $3
     LIMIT 500`,
    [outletId, from, to]
  );
  for (const session of await hydrateSessions(missing)) {
    await run("UPDATE pos_sessions SET grand_total = $1 WHERE id = $2", [
      calculatePosBill(session).grandTotal,
      session.sessionId,
    ]);
  }
}

/**
 * Every paid bill of one restaurant in a period, newest first, from every terminal that bills
 * for it. Search matches the bill number, the exact total, the table, the waiter, or a
 * guest's name or mobile number.
 */
export async function listSalesHistory(userId: string, params: URLSearchParams): Promise<SalesHistory> {
  const outletId = Number(params.get("outletId"));
  const outletName = Number.isSafeInteger(outletId) ? await billableOutletName(userId, outletId) : null;
  if (outletName === null) {
    throw new SalesHistoryAccessError("You do not have access to this restaurant's bills.");
  }
  const from = isoParam(params.get("from"), "start");
  const to = isoParam(params.get("to"), "end");
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days <= 0 || days > MAX_RANGE_DAYS) {
    throw new Error(`Choose a period of up to ${MAX_RANGE_DAYS} days.`);
  }
  const query = (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  const pageSize = Math.min(Math.max(Math.trunc(Number(params.get("limit"))) || PAGE_SIZE, 1), PAGE_SIZE);
  const [beforeAt, beforeId] = (params.get("before") ?? "").split("|");
  const hasCursor = Boolean(beforeAt && beforeId && Number.isFinite(Date.parse(beforeAt)));

  await fillMissingTotals(outletId, from, to);

  const totals = await rows<Record<string, unknown>>(
    `SELECT payment_method, COUNT(*)::int AS bills, COALESCE(SUM(grand_total), 0)::int AS total
     FROM pos_sessions
     WHERE outlet_id = $1 AND status = 'SETTLED' AND payment_settled_at >= $2 AND payment_settled_at < $3
     GROUP BY payment_method`,
    [outletId, from, to]
  );
  const byMethod: Record<PosPaymentMethod, number> = { CASH: 0, CARD: 0, UPI: 0 };
  let bills = 0;
  let total = 0;
  for (const row of totals) {
    const method = String(row.payment_method);
    if (method === "CASH" || method === "CARD" || method === "UPI") byMethod[method] += Number(row.total);
    bills += Number(row.bills);
    total += Number(row.total);
  }

  const like = `%${escapeLike(query)}%`;
  const digits = /^\d+$/.test(query) ? Number(query) : null;
  // "2" is bill 2 or ₹2; a mobile number is searched from its last four digits or more.
  const phoneLike = /^\d{4,}$/.test(query) ? like : null;
  const found = await rows<Record<string, unknown>>(
    `SELECT * FROM pos_sessions s
     WHERE s.outlet_id = $1 AND s.status = 'SETTLED'
       AND s.payment_settled_at >= $2 AND s.payment_settled_at < $3
       AND ($4 = '' OR s.bill_number = $5 OR s.grand_total = $5 OR s.table_id ILIKE $4
         OR s.server_name ILIKE $6
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements(s.guests_json::jsonb) AS g
           WHERE g->>'name' ILIKE $6 OR g->>'phone' LIKE $11
         ))
       AND (NOT $7 OR (s.payment_settled_at, s.id) < ($8, $9))
     ORDER BY s.payment_settled_at DESC, s.id DESC
     LIMIT $10`,
    [outletId, from, to, query, digits, like, hasCursor, beforeAt ?? "", beforeId ?? "", pageSize + 1, phoneLike]
  );
  const page = found.slice(0, pageSize);
  const sessions = await hydrateSessions(page);
  const codes = page.length
    ? await rows<Record<string, unknown>>(
        "SELECT session_id, claim_code FROM dine_in_bills WHERE session_id = ANY($1::text[])",
        [page.map((row) => String(row.id))]
      )
    : [];
  const codeOf = new Map(codes.map((row) => [String(row.session_id), String(row.claim_code)]));
  const rowOf = new Map(page.map((row) => [String(row.id), row]));

  const last = page.at(-1);
  return {
    outletName,
    summary: { bills, total, byMethod },
    entries: sessions.map((session) => {
      const row = rowOf.get(session.sessionId);
      return {
        session,
        billNumber: row?.bill_number == null ? null : Number(row.bill_number),
        grandTotal: calculatePosBill(session).grandTotal,
        claimCode: codeOf.get(session.sessionId) ?? null,
      };
    }),
    nextCursor:
      found.length > pageSize && last ? `${String(last.payment_settled_at)}|${String(last.id)}` : null,
  };
}
