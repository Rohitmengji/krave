import type { PosBill, PosTableSession } from "./posEngine";

/**
 * A bill as a one-page PDF, laid out like the thermal receipt: one monospaced column.
 *
 * Written by hand rather than with a library. The built-in Courier fonts need no embedding, so
 * the file is a few kilobytes and builds the same on the server and in a browser. Their
 * encoding (WinAnsi) has no ₹, so amounts read "Rs." as on the SMS, and any other character it
 * cannot show becomes "?" rather than breaking the file.
 */
export interface BillPdfInput {
  session: PosTableSession;
  bill: PosBill;
  billNumber: number | null;
  claimCode: string | null;
  /** When it was paid, or opened if unpaid, already written in the restaurant's time zone. */
  dateText: string;
  /** Printed under the restaurant's name; "" when not on record. */
  fssaiNumber: string;
  gstin: string;
}

interface Line {
  text: string;
  bold?: boolean;
}

const COLUMNS = 40;
const FONT_SIZE = 10;
const CHAR_WIDTH = FONT_SIZE * 0.6;
const LINE_HEIGHT = 13;
const MARGIN = 20;
const NAME_COLUMNS = 24;

// WinAnsi bytes 0x80-0x9F, which Latin-1 leaves to control characters.
const WIN_ANSI_EXTRA: Readonly<Record<string, number>> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88,
  "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92, "“": 0x93,
  "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b,
  "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
};

function winAnsiByte(char: string): number | null {
  const code = char.codePointAt(0) ?? 0;
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return WIN_ANSI_EXTRA[char] ?? null;
}

/** Text the Courier fonts can draw, one character per column. */
export function printable(text: string): string {
  let out = "";
  for (const char of text.replace(/₹\s?/g, "Rs.").replace(/\u2212/g, "-").replace(/\s+/g, " ")) {
    out += winAnsiByte(char) === null ? "?" : char;
  }
  return out;
}

/** A PDF string literal: delimiters escaped, and bytes above ASCII as octal so the file stays 7-bit. */
function pdfString(text: string): string {
  let out = "(";
  for (const char of text) {
    const byte = winAnsiByte(char) ?? 0x3f;
    if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += `\\${String.fromCharCode(byte)}`;
    else if (byte < 0x80) out += String.fromCharCode(byte);
    else out += `\\${byte.toString(8).padStart(3, "0")}`;
  }
  return `${out})`;
}

function wrap(text: string, width: number): string[] {
  const words = printable(text).trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    for (let start = 0; start < word.length; start += width) {
      const piece = word.slice(start, start + width);
      if (!current) current = piece;
      else if (current.length + 1 + piece.length <= width) current += ` ${piece}`;
      else {
        lines.push(current);
        current = piece;
      }
    }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

function center(text: string): string {
  const clean = printable(text).slice(0, COLUMNS);
  return " ".repeat(Math.floor((COLUMNS - clean.length) / 2)) + clean;
}

function row(left: string, right: string): string {
  const value = printable(right);
  const label = printable(left).slice(0, COLUMNS - value.length - 1);
  return label + " ".repeat(COLUMNS - label.length - value.length) + value;
}

function money(value: number): string {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function itemRows(name: string, quantity: number, amount: number): Line[] {
  const [first, ...rest] = wrap(name, NAME_COLUMNS);
  const qty = String(quantity).padStart(4);
  const value = money(amount).padStart(COLUMNS - NAME_COLUMNS - 4);
  return [{ text: first.padEnd(NAME_COLUMNS) + qty + value }, ...rest.map((text) => ({ text: `  ${text}` }))];
}

function billLines(input: BillPdfInput): Line[] {
  const { session, bill, billNumber, claimCode, dateText } = input;
  const rule: Line = { text: "-".repeat(COLUMNS) };
  const guests = `${session.guestCount} guest${session.guestCount === 1 ? "" : "s"}`;
  const lines: Line[] = [
    ...wrap(session.outletName, COLUMNS).map((text) => ({ text: center(text), bold: true })),
  ];
  if (input.gstin) lines.push({ text: center(`GSTIN ${input.gstin}`) });
  if (input.fssaiNumber) lines.push({ text: center(`FSSAI Lic. No. ${input.fssaiNumber}`) });
  lines.push({ text: center(session.status === "SETTLED" ? "BILL - PAID" : "BILL") });
  if (billNumber !== null) lines.push({ text: center(`Bill No. ${billNumber}`), bold: true });
  lines.push(
    { text: center(`Table ${session.tableId} - ${guests}`) },
    { text: center(`Server: ${session.serverName}`) },
    { text: center(dateText) },
    rule,
    { text: "Item".padEnd(NAME_COLUMNS) + " Qty" + "Amount".padStart(COLUMNS - NAME_COLUMNS - 4), bold: true }
  );
  for (const line of session.lines) {
    lines.push(...itemRows(line.name, line.quantity, line.unitPrice * line.quantity));
  }
  lines.push(rule, { text: row("Subtotal", money(bill.subtotal)) });
  if (bill.discountAmount > 0) {
    lines.push({ text: row(`Discount (${session.discountPercent}%)`, `-${money(bill.discountAmount)}`) });
  }
  if (bill.serviceCharge > 0) {
    lines.push({ text: row(`Service (${session.serviceChargePercent}%)`, money(bill.serviceCharge)) });
  }
  if (bill.cgstRateBps + bill.sgstRateBps > 0) {
    lines.push(
      { text: row(`CGST ${bill.cgstRateBps / 100}%`, money(bill.cgst)) },
      { text: row(`SGST ${bill.sgstRateBps / 100}%`, money(bill.sgst)) }
    );
  }
  lines.push(
    { text: row("Round off", money(bill.roundOff)) },
    { text: row("TOTAL", `Rs. ${bill.grandTotal}`), bold: true }
  );
  if (session.guestCount > 1) lines.push({ text: row("Per guest", `Rs. ${bill.perGuest}`) });
  if (session.payment) {
    lines.push(
      rule,
      { text: row("Paid by", session.payment.method) },
      { text: row("Tendered", `Rs. ${session.payment.amountTendered}`) },
      { text: row("Change", `Rs. ${session.payment.changeDue}`) }
    );
  }
  if (session.corrections.length > 0) {
    lines.push(rule);
    for (const correction of session.corrections) {
      const note = `Corrected: ${correction.detail}${correction.reason ? ` - ${correction.reason}` : ""}`;
      lines.push(...wrap(note, COLUMNS).map((text) => ({ text })));
    }
  }
  lines.push({ text: "" }, { text: center("Thank you! Please visit again.") });
  if (session.status === "SETTLED" && claimCode) {
    lines.push(
      rule,
      { text: center("Add this bill to your KRAVE account") },
      { text: center(claimCode), bold: true },
      ...wrap("Enter it under Your Orders. Valid for 30 days.", COLUMNS).map((text) => ({ text: center(text) }))
    );
  }
  if (bill.taxTotal > 0 && !input.gstin) {
    lines.push(
      { text: "" },
      ...wrap("Not a GST tax invoice: no GSTIN is on record for this restaurant.", COLUMNS).map(
        (text) => ({ text: center(text) })
      )
    );
  }
  return lines;
}

export function billPdf(input: BillPdfInput): Uint8Array {
  const lines = billLines(input);
  const width = MARGIN * 2 + COLUMNS * CHAR_WIDTH;
  const height = MARGIN * 2 + lines.length * LINE_HEIGHT;
  const content = lines
    .map((line, index) => {
      const y = height - MARGIN - (index + 1) * LINE_HEIGHT + 3;
      return `BT /${line.bold ? "F2" : "F1"} ${FONT_SIZE} Tf ${MARGIN} ${y} Td ${pdfString(line.text)} Tj ET\n`;
    })
    .join("");
  const title = printable(`${input.session.outletName} - Table ${input.session.tableId} bill`);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] ` +
      "/Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    `<< /Title ${pdfString(title)} /Producer (KRAVE) >>`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\n`;
  pdf += `startxref\n${xref}\n%%EOF\n`;
  // Every character above is ASCII, so string offsets are byte offsets.
  return new TextEncoder().encode(pdf);
}
