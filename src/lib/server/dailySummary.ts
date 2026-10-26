import { atOutletClock, outletDateKey } from "@/lib/outletClock";
import { calculatePosBill, type PosPaymentMethod } from "@/lib/pos/posEngine";
import { readMailConfig, sendMail, type MailMessage } from "./mailer";
import { EMAIL_PARAGRAPH, EMAIL_SMALL, emailLayout, escapeHtml } from "./passwordResetMail";
import { one, rows } from "./pg";
import { hydrateSessions } from "./posStore";

const TOP_DISHES = 5;

/** One restaurant's paid bills for one day on its own clock, as the morning email reports them. */
export interface DailySummary {
  restaurantName: string;
  /** The day reported, `YYYY-MM-DD` on the outlet's clock. */
  dateKey: string;
  bills: number;
  /** Whole rupees, as on the bills. */
  total: number;
  covers: number;
  byMethod: Record<PosPaymentMethod, number>;
  discounts: number;
  voidedItems: number;
  topDishes: { name: string; quantity: number; amount: number }[];
  /** Tables open when the email is written: a bill left unpaid overnight shows up here. */
  openTables: number;
}

export async function buildDailySummary(
  outletId: number,
  restaurantName: string,
  from: Date,
  to: Date
): Promise<DailySummary> {
  const settled = await hydrateSessions(
    await rows<Record<string, unknown>>(
      `SELECT * FROM pos_sessions
       WHERE outlet_id = $1 AND status = 'SETTLED' AND payment_settled_at >= $2 AND payment_settled_at < $3`,
      [outletId, from.toISOString(), to.toISOString()]
    )
  );
  const byMethod: Record<PosPaymentMethod, number> = { CASH: 0, CARD: 0, UPI: 0 };
  const dishes = new Map<string, { quantity: number; amount: number }>();
  let total = 0;
  let covers = 0;
  let discounts = 0;
  let voidedItems = 0;
  for (const session of settled) {
    const bill = calculatePosBill(session);
    total += bill.grandTotal;
    covers += session.guestCount;
    discounts += bill.discountAmount;
    voidedItems += session.voids.reduce((sum, entry) => sum + entry.quantity, 0);
    if (session.payment) byMethod[session.payment.method] += bill.grandTotal;
    for (const line of session.lines) {
      const dish = dishes.get(line.name) ?? { quantity: 0, amount: 0 };
      dish.quantity += line.quantity;
      dish.amount += line.unitPrice * line.quantity;
      dishes.set(line.name, dish);
    }
  }
  const open = await one<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM pos_sessions WHERE outlet_id = $1 AND status = 'OPEN'",
    [outletId]
  );
  return {
    restaurantName,
    dateKey: outletDateKey(from),
    bills: settled.length,
    total,
    covers,
    byMethod,
    discounts: Math.round(discounts * 100) / 100,
    voidedItems,
    topDishes: [...dishes]
      .map(([name, dish]) => ({ name, ...dish }))
      .sort((a, b) => b.quantity - a.quantity || b.amount - a.amount || a.name.localeCompare(b.name))
      .slice(0, TOP_DISHES),
    openTables: open?.count ?? 0,
  };
}

function rupees(value: number): string {
  return `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function dayLabel(dateKey: string): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return new Intl.DateTimeFormat("en-IN", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

export function dailySummaryEmail(to: string, summary: DailySummary, origin: string): MailMessage {
  const day = dayLabel(summary.dateKey);
  const { byMethod } = summary;
  const facts = [
    `Sales: ${rupees(summary.total)} from ${summary.bills} bill${summary.bills === 1 ? "" : "s"}, ${summary.covers} guests.`,
    `Cash ${rupees(byMethod.CASH)} · UPI ${rupees(byMethod.UPI)} · Card ${rupees(byMethod.CARD)}`,
    ...(summary.discounts > 0 ? [`Discounts given: ${rupees(summary.discounts)}`] : []),
    ...(summary.voidedItems > 0 ? [`Items voided after going to the kitchen: ${summary.voidedItems}`] : []),
    ...(summary.openTables > 0 ? [`Tables still open this morning: ${summary.openTables}`] : []),
  ];
  const dishes = summary.topDishes.map(
    (dish, index) => `${index + 1}. ${dish.name} ×${dish.quantity} (${rupees(dish.amount)})`
  );
  const stop = `To stop this email, untick "Email me yesterday's sales" under Restaurant details: ${origin}/owner`;
  return {
    to,
    subject: `${summary.restaurantName}: ${rupees(summary.total)} on ${day}`,
    text: [
      `${summary.restaurantName}, ${day}`,
      "",
      ...facts,
      "",
      "Top dishes:",
      ...dishes,
      "",
      `Every bill is under Sales on the table terminal: ${origin}/pos`,
      stop,
    ].join("\n"),
    html: emailLayout(
      `${summary.restaurantName}, ${day}`,
      [
        ...facts.map((fact) => `<p style="${EMAIL_PARAGRAPH}">${escapeHtml(fact)}</p>`),
        `<p style="${EMAIL_PARAGRAPH}"><strong>Top dishes</strong><br>${dishes.map(escapeHtml).join("<br>")}</p>`,
        `<p style="${EMAIL_SMALL}">Every bill is under Sales on the <a href="${escapeHtml(`${origin}/pos`)}">table terminal</a>.</p>`,
        `<p style="${EMAIL_SMALL}">${escapeHtml(stop)}</p>`,
      ].join("\n")
    ),
  };
}

/**
 * Emails each owner yesterday's takings, once per restaurant and day. The day is claimed in
 * the database before anything is sent, so a retried or doubled cron run cannot email twice.
 * A day with no paid bills sends nothing.
 */
export async function sendDailySummaries(now: Date, origin: string): Promise<{ sent: number }> {
  const config = readMailConfig();
  if (!config) return { sent: 0 };
  const from = atOutletClock(now, 0, 0, -1);
  const to = atOutletClock(now, 0, 0, 0);
  const dateKey = outletDateKey(from);
  const restaurants = await rows<{ id: string; name: string; pos_outlet_id: number }>(
    `SELECT id, name, pos_outlet_id FROM managed_restaurants
     WHERE status <> 'suspended' AND daily_summary_enabled = 1`
  );
  let sent = 0;
  for (const restaurant of restaurants) {
    const claimed = await one(
      `INSERT INTO restaurant_daily_summaries (restaurant_id, report_date, sent_at)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING restaurant_id`,
      [restaurant.id, dateKey, now.toISOString()]
    );
    if (!claimed) continue;
    const summary = await buildDailySummary(Number(restaurant.pos_outlet_id), restaurant.name, from, to);
    if (summary.bills === 0) continue;
    const owners = await rows<{ email: string }>(
      `SELECT u.email FROM restaurant_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.restaurant_id = $1 AND m.role = 'owner' AND u.email_verified_at IS NOT NULL`,
      [restaurant.id]
    );
    for (const owner of owners) {
      try {
        await sendMail(dailySummaryEmail(owner.email, summary, origin), config);
        sent += 1;
      } catch (error) {
        console.error("[krave] Daily summary email failed.", error);
      }
    }
  }
  return { sent };
}
