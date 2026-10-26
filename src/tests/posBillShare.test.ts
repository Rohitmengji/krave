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
import { GET } from "@/app/b/[token]/route";
import { registerUser } from "@/lib/server/auth";
import {
  BILL_EMAIL_OFF,
  BILL_NOT_SAVED,
  billLinkToken,
  emailBill,
  loadSharedBill,
  sharedBillPdf,
} from "@/lib/server/posBillShare";
import { syncPosState } from "@/lib/server/posStore";
import {
  addItemToSession,
  openTableSession,
  sendPendingToKitchen,
  settleSession,
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
const PIN = "135790";
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe.skipIf(!hasTestDatabase)("sending a bill as a PDF", () => {
  beforeAll(startTestDatabase);
  afterAll(stopTestDatabase);
  beforeEach(async () => {
    await resetTestDatabase();
    sent.length = 0;
    vi.unstubAllEnvs();
  });

  async function savedTable() {
    const owner = await registerUser({ email: "owner@bill.test", password: PIN });
    const outlet = await seedPosOutlet(owner);
    const table = openTableSession({
      ...outletInput(outlet),
      tableId: "T2",
      guestCount: 2,
      serverName: "Hemant",
    });
    const fired = sendPendingToKitchen(addItemToSession(table, outlet.menu[0], 2)).session;
    const [saved] = (await syncPosState(owner.id, { sessions: [fired], shift: null })).sessions;
    return { owner, saved };
  }

  it("gives each saved table one link, and only to someone who bills for it", async () => {
    const { owner, saved } = await savedTable();
    const token = await billLinkToken(owner.id, saved.sessionId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await billLinkToken(owner.id, saved.sessionId)).toBe(token);

    const stranger = await registerUser({ email: "stranger@bill.test", password: PIN });
    await expect(billLinkToken(stranger.id, saved.sessionId)).rejects.toThrow(BILL_NOT_SAVED);
    await expect(billLinkToken(owner.id, "POS-only-on-the-phone")).rejects.toThrow(BILL_NOT_SAVED);
    await expect(billLinkToken(owner.id, "../../etc")).rejects.toThrow("Choose a bill to send.");
  });

  it("serves the bill as it stands now, before and after it is paid", async () => {
    const { owner, saved } = await savedTable();
    const token = await billLinkToken(owner.id, saved.sessionId);
    const open = await loadSharedBill(token);
    expect(open?.session.status).toBe("OPEN");
    expect(text(sharedBillPdf(open!))).not.toContain("BILL - PAID");

    await syncPosState(owner.id, { sessions: [settleSession(saved, "UPI", 0)], shift: null });
    const paid = await loadSharedBill(token);
    expect(paid).toMatchObject({ billNumber: 1, session: { status: "SETTLED" } });
    expect(paid?.claimCode).toEqual(expect.any(String));
    expect(text(sharedBillPdf(paid!))).toContain("BILL - PAID");

    expect(await loadSharedBill("not-a-token")).toBeNull();
    expect(await loadSharedBill("A".repeat(22))).toBeNull();
  });

  it("opens as a PDF for anyone with the link, and for nobody without it", async () => {
    const { owner, saved } = await savedTable();
    const token = await billLinkToken(owner.id, saved.sessionId);
    const response = await GET(new NextRequest(`http://localhost/b/${token}`), {
      params: Promise.resolve({ token }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-disposition")).toBe(
      'inline; filename="Jagadamba-Maratha-Khanawali-bill-T2.pdf"'
    );
    expect(text(new Uint8Array(await response.arrayBuffer())).startsWith("%PDF-1.4")).toBe(true);

    const missing = await GET(new NextRequest("http://localhost/b/nope"), {
      params: Promise.resolve({ token: "nope" }),
    });
    expect(missing.status).toBe(404);
  });

  it("emails the bill with the PDF attached, and says plainly when email is not set up", async () => {
    const { owner, saved } = await savedTable();
    const input = { sessionId: saved.sessionId, email: " Guest@Example.com " };
    await expect(emailBill(owner.id, input, SITE)).rejects.toThrow(BILL_EMAIL_OFF);

    vi.stubEnv("SMTP_HOST", "smtp.example.test");
    vi.stubEnv("SMTP_USER", "sender@krave.test");
    vi.stubEnv("SMTP_PASS", "app-password");
    await expect(emailBill(owner.id, { ...input, email: "not-an-email" }, SITE)).rejects.toThrow(
      "Enter a valid email address."
    );
    expect(await emailBill(owner.id, input, SITE)).toEqual({ sentTo: "guest@example.com" });

    expect(sent).toHaveLength(1);
    const [mail] = sent;
    expect(mail.to).toBe("guest@example.com");
    expect(mail.subject).toContain("Jagadamba Maratha Khanawali");
    expect(mail.text).toContain(`${SITE}/b/${await billLinkToken(owner.id, saved.sessionId)}`);
    expect(mail.attachments?.[0]).toMatchObject({
      contentType: "application/pdf",
      filename: "Jagadamba-Maratha-Khanawali-bill-T2.pdf",
    });
    expect(text(mail.attachments![0].content).startsWith("%PDF-1.4")).toBe(true);
  });
});
