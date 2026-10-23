import { randomInt } from "node:crypto";
import { one, rows, run } from "./pg";
import { calculatePosBill, type PosTableSession } from "@/lib/pos/posEngine";

/** No vowels, no 0/O/1/I: unambiguous when read off a printed receipt. */
const CODE_ALPHABET = "2345679BCDFGHJKLMNPQRSTVWXYZ";
const CODE_LENGTH = 10;
const CLAIM_WINDOW_DAYS = 30;

export interface DineInBill {
  sessionId: string;
  outletId: number;
  outletName: string;
  tableId: string;
  guestCount: number;
  settledAt: string;
  paymentMethod: string;
  grandTotal: number;
  lines: { name: string; quantity: number; amount: number }[];
  /** Only ever returned to the counter that printed it, never to a claimer. */
  claimCode?: string;
}

function generateClaimCode(): string {
  let code = "";
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

function toBill(row: Record<string, unknown>, includeCode: boolean): DineInBill {
  return {
    sessionId: String(row.session_id),
    outletId: Number(row.outlet_id),
    outletName: String(row.outlet_name),
    tableId: String(row.table_id),
    guestCount: Number(row.guest_count),
    settledAt: String(row.settled_at),
    paymentMethod: String(row.payment_method),
    grandTotal: Number(row.grand_total),
    lines: JSON.parse(String(row.lines_json)) as DineInBill["lines"],
    ...(includeCode ? { claimCode: String(row.claim_code) } : {}),
  };
}

/**
 * Record settled tables as claimable bills. Totals are recomputed here rather than taken
 * from the terminal, for the same reason sync reprices lines: an offline device is not a
 * source of truth about money.
 */
export async function recordSettledBills(sessions: PosTableSession[]): Promise<void> {
  for (const session of sessions) {
    if (session.status !== "SETTLED" || !session.payment) continue;
    const bill = calculatePosBill(session);
    await run(
      `INSERT INTO dine_in_bills (session_id, outlet_id, outlet_name, table_id, guest_count,
         settled_at, payment_method, grand_total, lines_json, claim_code, claimed_by, claimed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL)
       ON CONFLICT (session_id) DO NOTHING`,
      [
        session.sessionId,
        session.outletId,
        session.outletName,
        session.tableId,
        session.guestCount,
        session.payment.settledAt,
        session.payment.method,
        bill.grandTotal,
        JSON.stringify(
          session.lines.map((line) => ({
            name: line.name,
            quantity: line.quantity,
            amount: line.unitPrice * line.quantity,
          }))
        ),
        generateClaimCode(),
      ]
    );
  }
}

/** The counter needs the code to print it; nobody else ever receives it. */
export async function getClaimCode(sessionId: string): Promise<string | null> {
  const row = await one<Record<string, unknown>>(
    "SELECT claim_code FROM dine_in_bills WHERE session_id = $1",
    [sessionId]
  );
  return row ? String(row.claim_code) : null;
}

export async function claimDineInBill(userId: string, input: unknown): Promise<DineInBill> {
  const raw = (input ?? {}) as Record<string, unknown>;
  const code = typeof raw.code === "string" ? raw.code.trim().toUpperCase() : "";
  if (code.length !== CODE_LENGTH) {
    throw new Error("That code is not valid or has already been used.");
  }

  const cutoff = new Date(Date.now() - CLAIM_WINDOW_DAYS * 86_400_000).toISOString();

  // Claimed in a single guarded statement rather than read-then-write: with a pooled,
  // async driver two people entering the same code could otherwise both pass the check.
  // One message for every failure: unknown, already taken, or too old. The codes are
  // unguessable, so there is nothing to gain by telling a prober which it was.
  const claimed = await one<Record<string, unknown>>(
    `UPDATE dine_in_bills
     SET claimed_by = $1, claimed_at = $2
     WHERE claim_code = $3 AND claimed_by IS NULL AND settled_at >= $4
     RETURNING *`,
    [userId, new Date().toISOString(), code, cutoff]
  );

  if (!claimed) {
    throw new Error("That code is not valid or has already been used.");
  }

  return toBill(claimed, false);
}

export async function listDineInBills(userId: string): Promise<DineInBill[]> {
  const found = await rows<Record<string, unknown>>(
    "SELECT * FROM dine_in_bills WHERE claimed_by = $1 ORDER BY settled_at DESC LIMIT 30",
    [userId]
  );
  return found.map((row) => toBill(row, false));
}
