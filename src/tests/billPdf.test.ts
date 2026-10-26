import { describe, expect, it } from "vitest";
import { billPdf, printable } from "@/lib/pos/billPdf";
import {
  addItemToSession,
  calculatePosBill,
  openTableSession,
  sendPendingToKitchen,
  settleSession,
  type PosMenuItem,
  type PosTableSession,
} from "@/lib/pos/posEngine";

function dish(itemId: string, name: string, price: number): PosMenuItem {
  return {
    itemId,
    name,
    dishId: itemId,
    dishName: name,
    portion: null,
    price,
    categoryName: "Meals",
    dietary: "non-veg",
    bestseller: false,
  };
}

function table(...dishes: [PosMenuItem, number][]): PosTableSession {
  let session = openTableSession({
    outletId: 7,
    outletName: "Jagadamba Maratha Khanawali",
    taxRateBps: 500,
    tableId: "T2",
    guestCount: 2,
    serverName: "Hemant",
  });
  for (const [item, quantity] of dishes) session = addItemToSession(session, item, quantity);
  return sendPendingToKitchen(session).session;
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("bill PDF", () => {
  const paid = (() => {
    const session = table([dish("a", "Chicken Biriyani (Full)", 100), 2], [dish("b", "Chicken 65", 50), 1]);
    return settleSession(session, "CASH", calculatePosBill(session).grandTotal);
  })();

  it("is a well-formed PDF whose cross-reference table points at every object", () => {
    const pdf = decode(billPdf({ session: paid, bill: calculatePosBill(paid), billNumber: 12, claimCode: null, dateText: "25/10/2026, 3:20 pm" }));
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf.endsWith("%%EOF\n")).toBe(true);

    const xrefAt = Number(pdf.match(/startxref\n(\d+)\n/)?.[1]);
    expect(pdf.slice(xrefAt, xrefAt + 4)).toBe("xref");
    const offsets = [...pdf.slice(xrefAt).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
    expect(offsets).toHaveLength(7);
    offsets.forEach((offset, index) => expect(pdf.slice(offset).startsWith(`${index + 1} 0 obj`)).toBe(true));

    const stream = pdf.match(/<< \/Length (\d+) >>\nstream\n([\s\S]*?)endstream/);
    expect(Number(stream?.[1])).toBe(stream?.[2].length);
  });

  it("carries the order, the total in rupees and the payment, with brackets escaped", () => {
    const bill = calculatePosBill(paid);
    const pdf = decode(billPdf({ session: paid, bill, billNumber: 12, claimCode: "ABCD2345", dateText: "25/10/2026, 3:20 pm" }));
    expect(pdf).toContain("(Chicken Biriyani \\(Full\\)    2      200.00)");
    expect(pdf).toContain("BILL - PAID");
    expect(pdf).toContain("Bill No. 12");
    expect(pdf).toContain(`Rs. ${bill.grandTotal})`);
    expect(pdf).toContain("CASH)");
    expect(pdf).toContain("ABCD2345");
    expect(pdf).toContain("Not a GST tax invoice");
  });

  it("never lets an unusual name break the file or the columns", () => {
    const session = table(
      [dish("a", "मटण थाळी Special ₹ Thali with extra Solai and Papad", 120), 1],
      [dish("b", "Crème brûlée", 90), 1]
    );
    const pdf = decode(billPdf({ session, bill: calculatePosBill(session), billNumber: null, claimCode: null, dateText: "now" }));
    // Every byte is 7-bit, Latin accents are octal escapes and other scripts are "?".
    expect([...pdf].every((char) => char.charCodeAt(0) < 0x80)).toBe(true);
    expect(pdf).toContain("Cr\\350me br\\373l\\351e");
    expect(pdf).toContain("Rs.");
    expect(pdf).not.toContain("BILL - PAID");
    for (const [, text] of pdf.matchAll(/Td \((.*)\) Tj ET/g)) {
      expect(text.replace(/\\(\d{3}|.)/g, "x").length).toBeLessThanOrEqual(40);
    }
  });

  it("keeps what Courier can show and replaces what it cannot", () => {
    expect(printable("₹ 120 – done")).toBe("Rs.120 – done");
    expect(printable("नमस्ते Ramesh")).toBe("?????? Ramesh");
    expect(printable("a\n\tb")).toBe("a b");
  });
});
