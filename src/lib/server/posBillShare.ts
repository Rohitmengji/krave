import { randomBytes } from "node:crypto";
import { billPdf } from "@/lib/pos/billPdf";
import { calculatePosBill, type PosTableSession } from "@/lib/pos/posEngine";
import { LOGIN_WINDOW_MINUTES, normalizeEmail, reserveClientQuota } from "./auth";
import { getClaimCode } from "./dineInStore";
import { readMailConfig, sendMail, type MailMessage } from "./mailer";
import { EMAIL_PARAGRAPH, EMAIL_SMALL, emailLayout, escapeHtml } from "./passwordResetMail";
import { one, rows } from "./pg";
import { BILLABLE_RESTAURANT_SQL } from "./posCatalog";
import { hydrateSessions } from "./posStore";
import { isRestaurantAdmin } from "./restaurantStore";

export const BILL_NOT_SAVED =
  "This bill is not saved yet. Wait until the terminal says Saved, then try again.";
export const BILL_EMAIL_OFF = "Email is not set up on this server yet. Send it on WhatsApp or SMS.";
const BILL_EMAILS_PER_WINDOW = 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const DEFAULT_TIME_ZONE = "Asia/Kolkata";

export interface SharedBill {
  session: PosTableSession;
  billNumber: number | null;
  claimCode: string | null;
  timeZone: string;
}

/**
 * The guest's link to a bill: made once per table and kept, so a resend points to the same
 * place. Anyone who can bill the outlet may make it; the table must already be on the server.
 */
export async function billLinkToken(userId: string, sessionId: unknown): Promise<string> {
  if (typeof sessionId !== "string" || !/^[\w-]{1,80}$/.test(sessionId)) {
    throw new Error("Choose a bill to send.");
  }
  const table = await one<{ outlet_id: number }>(
    `SELECT s.outlet_id FROM pos_sessions s
     WHERE s.id = $3
       AND s.outlet_id IN (SELECT r.pos_outlet_id FROM managed_restaurants r WHERE ${BILLABLE_RESTAURANT_SQL})`,
    [userId, await isRestaurantAdmin(userId), sessionId]
  );
  if (!table) throw new Error(BILL_NOT_SAVED);
  const link = await one<{ token: string }>(
    `INSERT INTO pos_bill_links (token, session_id, outlet_id, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (session_id) DO UPDATE SET session_id = EXCLUDED.session_id
     RETURNING token`,
    [randomBytes(16).toString("base64url"), sessionId, table.outlet_id, userId, new Date().toISOString()]
  );
  if (!link) throw new Error(BILL_NOT_SAVED);
  return link.token;
}

/** The bill behind a link, as it stands now: paid or not, after any correction. */
export async function loadSharedBill(token: string): Promise<SharedBill | null> {
  if (!TOKEN_PATTERN.test(token)) return null;
  const link = await one<{ session_id: string; outlet_id: number; time_zone: string | null }>(
    `SELECT l.session_id, l.outlet_id, r.time_zone
     FROM pos_bill_links l
     LEFT JOIN managed_restaurants r ON r.pos_outlet_id = l.outlet_id
     WHERE l.token = $1`,
    [token]
  );
  if (!link) return null;
  const tableRow = (id: string) =>
    rows<Record<string, unknown>>("SELECT * FROM pos_sessions WHERE id = $1 AND outlet_id = $2", [
      id,
      link.outlet_id,
    ]);
  let found = await tableRow(link.session_id);
  // A table merged into another is billed there, so the link follows it once.
  const mergedInto = found[0]?.status === "MERGED" ? found[0].merged_into_session_id : null;
  if (typeof mergedInto === "string") found = await tableRow(mergedInto);
  const [session] = await hydrateSessions(found);
  if (!session) return null;
  return {
    session,
    billNumber: found[0].bill_number == null ? null : Number(found[0].bill_number),
    claimCode: session.status === "SETTLED" ? await getClaimCode(session.sessionId) : null,
    timeZone: link.time_zone || DEFAULT_TIME_ZONE,
  };
}

function formatWhen(iso: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  try {
    return new Intl.DateTimeFormat("en-IN", { ...options, timeZone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-IN", { ...options, timeZone: DEFAULT_TIME_ZONE }).format(new Date(iso));
  }
}

export function sharedBillPdf(shared: SharedBill): Uint8Array {
  const { session } = shared;
  return billPdf({
    session,
    bill: calculatePosBill(session),
    billNumber: shared.billNumber,
    claimCode: shared.claimCode,
    dateText: formatWhen(session.payment?.settledAt ?? session.openedAt, shared.timeZone),
  });
}

/** "Jagadamba-Maratha-Khanawali-bill-12.pdf": ASCII only, so every mail client and phone keeps it. */
export function sharedBillFileName(shared: SharedBill): string {
  const name = shared.session.outletName.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "") || "bill";
  return `${name}-bill-${shared.billNumber ?? shared.session.tableId}.pdf`;
}

function billEmail(to: string, shared: SharedBill, link: string): MailMessage {
  const { session } = shared;
  const total = calculatePosBill(session).grandTotal;
  const what = `${session.outletName}, table ${session.tableId}, ₹${total}`;
  const paid = session.status === "SETTLED" ? "Paid. " : "";
  return {
    to,
    subject: `Your bill from ${session.outletName} - ₹${total}`,
    text: [
      "Hello,",
      "",
      `Your bill from ${what} is attached as a PDF. ${paid}You can also open it here:`,
      link,
      "",
      `Thank you for visiting ${session.outletName}!`,
    ].join("\n"),
    html: emailLayout(
      `Your bill from ${session.outletName}`,
      `<p style="${EMAIL_PARAGRAPH}">Your bill (${escapeHtml(what)}) is attached as a PDF. ${paid}</p>
<p style="${EMAIL_PARAGRAPH}"><a href="${escapeHtml(link)}" style="color:#047857;font-weight:700">Open the bill</a></p>
<p style="${EMAIL_SMALL}">Thank you for visiting ${escapeHtml(session.outletName)}!</p>`
    ),
    attachments: [
      { filename: sharedBillFileName(shared), content: sharedBillPdf(shared), contentType: "application/pdf" },
    ],
  };
}

/** Emails the bill as a PDF, straight from the server: the waiter only types the address. */
export async function emailBill(
  userId: string,
  input: unknown,
  origin: string
): Promise<{ sentTo: string }> {
  const body = (input ?? {}) as Record<string, unknown>;
  const to = normalizeEmail(body.email);
  if (!readMailConfig()) throw new Error(BILL_EMAIL_OFF);
  await reserveClientQuota(
    `bill-email:${userId}`,
    BILL_EMAILS_PER_WINDOW,
    `Too many bill emails. Try again in ${LOGIN_WINDOW_MINUTES} minutes.`
  );
  const token = await billLinkToken(userId, body.sessionId);
  const shared = await loadSharedBill(token);
  if (!shared) throw new Error(BILL_NOT_SAVED);
  await sendMail(billEmail(to, shared, `${origin}/b/${token}`));
  return { sentTo: to };
}
