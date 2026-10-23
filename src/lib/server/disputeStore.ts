import { one, rows, run, transaction } from "./pg";
import { listOrders } from "./accountStore";
import { recordAudit } from "./auditLog";
import { assertAnyOutletStaff } from "./staff";
import type { CrystalOrderState } from "@/types/krave";

export const DISPUTE_STATUSES = ["AUTO_REFUNDED", "UNDER_REVIEW", "REFUNDED", "DECLINED"] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];

export const DISPUTE_REASONS = ["MISSING_ITEM", "WRONG_ITEM", "QUALITY"] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];

/** A claim filed long after delivery cannot be checked against anything. */
export const DISPUTE_WINDOW_HOURS = 48;
/** Above this, a human looks at it rather than money moving automatically. */
export const AUTO_REFUND_CEILING = 500;
/** Repeated automatic refunds stop being automatic. */
export const AUTO_REFUND_RECENT_LIMIT = 2;
export const RECENT_WINDOW_DAYS = 30;
/** How long review is promised to take. Stated so it can be held to. */
export const REVIEW_SLA_HOURS = 24;

export interface DisputeLine {
  itemId: string;
  quantity: number;
}

export interface Dispute {
  id: string;
  orderId: string;
  reason: DisputeReason;
  status: DisputeStatus;
  /** Rupees. Zero for a declined claim. */
  refundAmount: number;
  /** What the claim was worth when filed, whether or not it has been paid. */
  assessedAmount: number;
  explanation: string;
  filedAt: string;
  reviewDueAt: string | null;
  resolvedAt: string | null;
}

function toDispute(row: Record<string, unknown>): Dispute {
  return {
    id: String(row.id),
    orderId: String(row.order_id),
    reason: String(row.reason) as DisputeReason,
    status: String(row.status) as DisputeStatus,
    refundAmount: Number(row.refund_amount),
    assessedAmount: Number(row.assessed_amount),
    explanation: String(row.explanation),
    filedAt: String(row.filed_at),
    reviewDueAt: row.review_due_at === null ? null : String(row.review_due_at),
    resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
  };
}

/**
 * What the customer actually handed over for food, excluding the tip and the fees
 * paid for a delivery that did happen.
 *
 * Refunding menu price would over-refund every discounted order, so the claimed
 * lines are refunded as their share of what was really paid.
 */
function refundableFoodValue(order: CrystalOrderState): number {
  const { grandTotal, riderTip, deliveryFee, platformFee } = order.quote;
  return Math.max(0, grandTotal - riderTip - deliveryFee - platformFee);
}

function claimedValue(order: CrystalOrderState, lines: DisputeLine[]): number {
  const { itemTotal } = order.quote;
  if (itemTotal <= 0) return 0;

  let listValue = 0;
  for (const claim of lines) {
    const line = order.items.find((candidate) => candidate.item.id === claim.itemId);
    if (!line) throw new Error("That item was not on this order.");
    if (
      !Number.isSafeInteger(claim.quantity) ||
      claim.quantity < 1 ||
      claim.quantity > line.quantity
    ) {
      throw new Error("You cannot claim more of an item than you ordered.");
    }
    listValue += line.unitPrice * claim.quantity;
  }

  return Math.min(
    refundableFoodValue(order),
    Math.round((listValue / itemTotal) * refundableFoodValue(order))
  );
}

async function recentAutoRefunds(userId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - RECENT_WINDOW_DAYS * 86_400_000).toISOString();
  const row = await one<Record<string, unknown>>(
    `SELECT COUNT(*) AS total FROM disputes
     WHERE user_id = $1 AND status = 'AUTO_REFUNDED' AND filed_at >= $2`,
    [userId, since]
  );
  return Number(row?.total ?? 0);
}

export async function fileDispute(
  userId: string,
  input: { orderId: string; reason: string; lines: DisputeLine[]; note?: string },
  now = new Date()
): Promise<Dispute> {
  const reason = DISPUTE_REASONS.find((candidate) => candidate === input.reason);
  if (!reason) throw new Error("Select a supported reason.");
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new Error("Tell us which items were affected.");
  }

  // Scoped to this user's own orders, so an order ID alone proves nothing.
  const orders = await listOrders(userId);
  const order = orders.find((candidate) => candidate.orderId === input.orderId);
  if (!order) throw new Error("That order is not in your history.");
  if (order.stage !== "ARRIVED") {
    throw new Error("You can raise this once the order has been delivered.");
  }

  const hoursSince = (now.getTime() - Date.parse(order.placedAt)) / 3_600_000;
  if (!Number.isFinite(hoursSince) || hoursSince > DISPUTE_WINDOW_HOURS) {
    throw new Error(`Claims close ${DISPUTE_WINDOW_HOURS} hours after delivery.`);
  }

  const refundAmount = claimedValue(order, input.lines);

  const tooLarge = refundAmount > AUTO_REFUND_CEILING;
  const tooMany = (await recentAutoRefunds(userId, now)) >= AUTO_REFUND_RECENT_LIMIT;
  const auto = !tooLarge && !tooMany && reason !== "QUALITY";

  const explanation = auto
    ? "Refunded automatically against what you paid for these items."
    : tooLarge
    ? `Above the ₹${AUTO_REFUND_CEILING} automatic limit, so someone will review it.`
    : tooMany
    ? "You have had several automatic refunds recently, so this one is reviewed."
    : "Quality reports are read by a person before any refund.";

  const dispute: Dispute = {
    id: `dsp_${crypto.randomUUID().slice(0, 10)}`,
    orderId: order.orderId,
    reason,
    status: auto ? "AUTO_REFUNDED" : "UNDER_REVIEW",
    refundAmount: auto ? refundAmount : 0,
    assessedAmount: refundAmount,
    explanation,
    filedAt: now.toISOString(),
    reviewDueAt: auto
      ? null
      : new Date(now.getTime() + REVIEW_SLA_HOURS * 3_600_000).toISOString(),
    resolvedAt: auto ? now.toISOString() : null,
  };

  try {
    await run(
      `INSERT INTO disputes (id, user_id, order_id, reason, status, refund_amount,
         assessed_amount, explanation, filed_at, review_due_at, note, resolved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        dispute.id,
        userId,
        dispute.orderId,
        dispute.reason,
        dispute.status,
        dispute.refundAmount,
        dispute.assessedAmount,
        dispute.explanation,
        dispute.filedAt,
        dispute.reviewDueAt,
        typeof input.note === "string" ? input.note.slice(0, 600) : "",
        dispute.resolvedAt,
      ]
    );
  } catch {
    // One claim per order: the UNIQUE index turns a double submit into this path.
    throw new Error("You have already raised a claim for this order.");
  }

  await recordAudit(
    userId,
    auto ? "DISPUTE_AUTO_REFUNDED" : "DISPUTE_FILED",
    dispute.id,
    `${reason} · assessed ₹${refundAmount}`,
    now
  );

  return dispute;
}

/**
 * Claims waiting on a human, oldest first so the SLA is worked in order.
 *
 * A viewer never sees their own claim here. `resolveDispute` refuses self-approval
 * anyway, but offering a button that is guaranteed to fail is its own kind of lie.
 */
export async function listDisputeQueue(viewerId: string): Promise<Dispute[]> {
  await assertAnyOutletStaff(viewerId);

  const found = await rows<Record<string, unknown>>(
    `SELECT * FROM disputes
     WHERE status = 'UNDER_REVIEW' AND user_id <> $1
     ORDER BY filed_at LIMIT 50`,
    [viewerId]
  );
  return found.map(toDispute);
}

/**
 * Settle a claim that a person had to look at.
 *
 * Deliberately refuses to let the claimant decide their own case, and refuses a
 * second decision, so an approval cannot be replayed into repeated refunds.
 */
export async function resolveDispute(
  resolverId: string,
  input: { disputeId: string; approve: boolean; note?: string },
  now = new Date()
): Promise<Dispute> {
  // Checked before any lookup, so a non-staff caller cannot probe which claim ids exist.
  await assertAnyOutletStaff(resolverId);

  const settled = await transaction(async (client) => {
    // Locked for the rest of the transaction: the status is read here and written below,
    // and two reviewers must not both see UNDER_REVIEW and both pay out.
    const found = await client.query("SELECT * FROM disputes WHERE id = $1 FOR UPDATE", [
      input.disputeId,
    ]);
    const row = found.rows[0] as Record<string, unknown> | undefined;

    if (!row) throw new Error("That claim no longer exists.");

    if (String(row.user_id) === resolverId) {
      throw new Error("You cannot decide your own claim.");
    }
    if (String(row.status) !== "UNDER_REVIEW") {
      throw new Error("That claim has already been settled.");
    }

    const assessed = Number(row.assessed_amount);
    const status: DisputeStatus = input.approve ? "REFUNDED" : "DECLINED";
    const refundAmount = input.approve ? assessed : 0;
    const note = typeof input.note === "string" ? input.note.slice(0, 600) : "";

    const updated = await client.query(
      `UPDATE disputes
         SET status = $1, refund_amount = $2, explanation = $3, resolved_at = $4,
             resolved_by = $5, resolution_note = $6
       WHERE id = $7 AND status = 'UNDER_REVIEW'
       RETURNING *`,
      [
        status,
        refundAmount,
        input.approve ? `Reviewed and refunded ₹${assessed}.` : "Reviewed and not refunded.",
        now.toISOString(),
        resolverId,
        note,
        input.disputeId,
      ]
    );

    if (updated.rowCount === 0) throw new Error("That claim has already been settled.");

    // Inside the transaction, so a settled claim can never lack its audit entry.
    await client.query(
      "INSERT INTO audit_log (actor_id, action, subject, detail, at) VALUES ($1, $2, $3, $4, $5)",
      [
        resolverId,
        input.approve ? "DISPUTE_REFUNDED" : "DISPUTE_DECLINED",
        input.disputeId,
        `₹${refundAmount}${note ? ` · ${note}` : ""}`.slice(0, 600),
        now.toISOString(),
      ]
    );

    return updated.rows[0] as Record<string, unknown>;
  });

  return toDispute(settled);
}

export async function listDisputes(userId: string): Promise<Dispute[]> {
  const found = await rows<Record<string, unknown>>(
    "SELECT * FROM disputes WHERE user_id = $1 ORDER BY filed_at DESC LIMIT 30",
    [userId]
  );
  return found.map(toDispute);
}
