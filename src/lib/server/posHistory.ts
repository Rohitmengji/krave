import { calculatePosBill, type PosPaymentMethod, type PosTableSession } from "@/lib/pos/posEngine";
import { rows, run } from "./pg";
import { billableOutletAccess, seesAllSales } from "./posCatalog";
import { hydrateSessions } from "./posStore";

const PAGE_SIZE = 40;
/** A waiter's lookup answers one bill, so a wrong guess cannot be paged through. */
const LOOKUP_SIZE = 3;
const MAX_RANGE_DAYS = 400;
const MAX_QUERY_LENGTH = 60;

export const SALES_LOOKUP_ONLY =
  "Only an owner or manager sees the full sales list. Type the bill number of a bill you took, or the guest's 10-digit mobile number, to find one bill.";

export interface SalesHistoryEntry {
  session: PosTableSession;
  billNumber: number | null;
  grandTotal: number;
  /** The receipt's claim code, so a reprint can carry it too. */
  claimCode: string | null;
}

export interface SalesHistory {
  outletName: string;
  /** For the whole period, whatever the search. Null for a waiter's single-bill lookup. */
  summary: { bills: number; total: number; byMethod: Record<PosPaymentMethod, number> } | null;
  entries: SalesHistoryEntry[];
  /** Pass back as `before` for the next page; null when there is nothing older. */
  nextCursor: string | null;
  /** "all" lists the restaurant's bills; "lookup" answers one searched-for bill. */
  scope: "all" | "lookup";
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
  const access = Number.isSafeInteger(outletId) ? await billableOutletAccess(userId, outletId) : null;
  if (access === null) {
    throw new SalesHistoryAccessError("You do not have access to this restaurant's bills.");
  }
  const outletName = access.name;
  const scope = seesAllSales(access.role) ? "all" : "lookup";
  const from = isoParam(params.get("from"), "start");
  const to = isoParam(params.get("to"), "end");
  const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
  if (days <= 0 || days > MAX_RANGE_DAYS) {
    throw new Error(`Choose a period of up to ${MAX_RANGE_DAYS} days.`);
  }
  const query = (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  const pageSize =
    scope === "lookup"
      ? LOOKUP_SIZE
      : Math.min(Math.max(Math.trunc(Number(params.get("limit"))) || PAGE_SIZE, 1), PAGE_SIZE);
  const [beforeAt, beforeId] = (params.get("before") ?? "").split("|");
  const hasCursor = scope === "all" && Boolean(beforeAt && beforeId && Number.isFinite(Date.parse(beforeAt)));

  // A waiter must name the bill: a bill number, or the whole mobile number the guest gave.
  const typedDigits = query.replace(/\D/g, "");
  const lookupPhone = scope === "lookup" && typedDigits.length >= 10 ? typedDigits.slice(-10) : null;
  const lookupBill = scope === "lookup" && lookupPhone === null && /^\d{1,9}$/.test(query) ? Number(query) : null;
  if (scope === "lookup" && lookupBill === null && lookupPhone === null) {
    throw new SalesHistoryAccessError(SALES_LOOKUP_ONLY);
  }

  await fillMissingTotals(outletId, from, to);

  const totals =
    scope === "all"
      ? await rows<Record<string, unknown>>(
          `SELECT payment_method, COUNT(*)::int AS bills, COALESCE(SUM(grand_total), 0)::int AS total
     FROM pos_sessions
     WHERE outlet_id = $1 AND status = 'SETTLED' AND payment_settled_at >= $2 AND payment_settled_at < $3
     GROUP BY payment_method`,
          [outletId, from, to]
        )
      : [];
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
  const found =
    scope === "lookup"
      ? await rows<Record<string, unknown>>(
          // Bill numbers run 1, 2, 3, so a waiter may name one only among the bills they took;
          // any other bill needs the mobile number the guest gives them.
          `SELECT * FROM pos_sessions s
     WHERE s.outlet_id = $1 AND s.status = 'SETTLED'
       AND s.payment_settled_at >= $2 AND s.payment_settled_at < $3
       AND ((s.bill_number = $4 AND s.user_id = $7) OR ($5::text IS NOT NULL AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(s.guests_json::jsonb) AS g
         WHERE right(g->>'phone', 10) = $5)))
     ORDER BY s.payment_settled_at DESC, s.id DESC
     LIMIT $6`,
          [outletId, from, to, lookupBill, lookupPhone, pageSize, userId]
        )
      : await rows<Record<string, unknown>>(
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
    scope,
    summary: scope === "all" ? { bills, total, byMethod } : null,
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
