import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailMessage } from "@/lib/server/mailer";

const sent = vi.hoisted(() => [] as MailMessage[]);

vi.mock("@/lib/server/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/mailer")>();
  return {
    ...actual,
    sendMail: async (message: MailMessage) => {
      sent.push(message);
    },
  };
});

import { NextRequest } from "next/server";
import { GET } from "@/app/api/cron/daily-summary/route";
import { registerUser } from "@/lib/server/auth";
import { sendDailySummaries } from "@/lib/server/dailySummary";
import { run } from "@/lib/server/pg";
import { syncPosState } from "@/lib/server/posStore";
import {
  addItemToSession,
  calculatePosBill,
  openTableSession,
  sendPendingToKitchen,
  settleSession,
  type PosOutlet,
  type PosPaymentMethod,
} from "@/lib/pos/posEngine";
import { outletInput } from "./support/posFixture";
import { seedPosOutlet } from "./support/posRestaurant";
import {
  hasTestDatabase,
  resetTestDatabase,
  startTestDatabase,
  stopTestDatabase,
} from "./support/testDb";

const SITE = "https://krave.example";
// "Yesterday" for a run a day from now is today, when the test bills are paid.
const tomorrow = () => new Date(Date.now() + 86_400_000);

describe("the morning sales email's cron route", () => {
  beforeEach(() => vi.unstubAllEnvs());

  it("runs only for Vercel Cron, which carries the secret", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(new NextRequest(`${SITE}/api/cron/daily-summary`))).status).toBe(503);

    vi.stubEnv("CRON_SECRET", "s3cret-value");
    // Every case is refused, so the job itself never runs here, against whatever DATABASE_URL is.
    for (const authorization of [undefined, "Bearer wrong", "s3cret-value", "Bearer s3cret-valuX", "bearer s3cret-value"]) {
      const response = await GET(
        new NextRequest(`${SITE}/api/cron/daily-summary`, {
          headers: authorization ? { authorization } : {},
        })
      );
      expect(response.status).toBe(401);
    }
  });
});

describe.skipIf(!hasTestDatabase)("the morning sales email", () => {
  beforeAll(startTestDatabase);
  afterAll(stopTestDatabase);
  beforeEach(async () => {
    await resetTestDatabase();
    sent.length = 0;
    vi.unstubAllEnvs();
    vi.stubEnv("SMTP_HOST", "smtp.example.test");
    vi.stubEnv("SMTP_USER", "sender@krave.test");
    vi.stubEnv("SMTP_PASS", "app-password");
  });

  async function restaurant() {
    const owner = await registerUser({ email: "owner@summary.test", password: "135790" });
    await run("UPDATE users SET email_verified_at = $1 WHERE id = $2", [new Date().toISOString(), owner.id]);
    return { owner, outlet: await seedPosOutlet(owner) };
  }

  function paidBill(outlet: PosOutlet, tableId: string, method: PosPaymentMethod, items: [number, number][]) {
    let session = openTableSession({ ...outletInput(outlet), tableId, guestCount: 2, serverName: "Asha" });
    for (const [index, quantity] of items) session = addItemToSession(session, outlet.menu[index], quantity);
    session = sendPendingToKitchen(session).session;
    return settleSession(session, method, calculatePosBill(session).grandTotal);
  }

  it("tells the owner yesterday's takings once, with the split and the dishes that sold", async () => {
    const { owner, outlet } = await restaurant();
    const cash = paidBill(outlet, "T1", "CASH", [[0, 2]]);
    const upi = paidBill(outlet, "T2", "UPI", [[0, 1], [3, 1]]);
    await syncPosState(owner.id, { sessions: [cash, upi] });

    expect(await sendDailySummaries(tomorrow(), SITE)).toEqual({ sent: 1 });
    expect(sent).toHaveLength(1);
    const [mail] = sent;
    const total = calculatePosBill(cash).grandTotal + calculatePosBill(upi).grandTotal;
    expect(mail.to).toBe("owner@summary.test");
    expect(mail.subject).toContain(`Jagadamba Maratha Khanawali: ₹${total.toLocaleString("en-IN")}`);
    expect(mail.text).toContain("from 2 bills, 4 guests.");
    expect(mail.text).toContain(`Cash ₹${calculatePosBill(cash).grandTotal}`);
    expect(mail.text).toContain(`UPI ₹${calculatePosBill(upi).grandTotal}`);
    expect(mail.text).toContain(`1. ${outlet.menu[0].name} ×3`);
    expect(mail.text).toContain(`${SITE}/owner`);

    // A retried or doubled run on the same morning sends nothing more.
    expect(await sendDailySummaries(tomorrow(), SITE)).toEqual({ sent: 0 });
    expect(sent).toHaveLength(1);
  });

  it("sends nothing for a quiet day, when switched off, or without email set up", async () => {
    const { owner, outlet } = await restaurant();
    expect(await sendDailySummaries(tomorrow(), SITE)).toEqual({ sent: 0 });

    await syncPosState(owner.id, { sessions: [paidBill(outlet, "T1", "CASH", [[0, 1]])] });
    await run("DELETE FROM restaurant_daily_summaries");
    await run("UPDATE managed_restaurants SET daily_summary_enabled = 0");
    expect(await sendDailySummaries(tomorrow(), SITE)).toEqual({ sent: 0 });

    await run("UPDATE managed_restaurants SET daily_summary_enabled = 1");
    vi.stubEnv("SMTP_HOST", "");
    expect(await sendDailySummaries(tomorrow(), SITE)).toEqual({ sent: 0 });
    expect(sent).toHaveLength(0);
  });
});
