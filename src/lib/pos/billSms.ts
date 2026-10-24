/**
 * Bill texts are sent from the restaurant's own phone and SIM through an `sms:` link, so staff
 * tap Send in the messaging app and nothing goes through a paid gateway. "Rs." rather than "₹"
 * keeps the text in the GSM alphabet, where one SMS holds 160 characters instead of 70.
 */
export interface BillSmsInput {
  outletName: string;
  tableId: string;
  guestName: string;
  total: number;
  guestCount: number;
  /** This guest's part of a split bill; null when one person pays the whole bill. */
  share: number | null;
  paid: boolean;
}

export function billSmsText(input: BillSmsInput): string {
  const greeting = input.guestName.trim() ? `Hi ${input.guestName.trim()}` : "Hello";
  const thanks = input.paid ? "Paid, thank you for visiting!" : "Thank you!";
  if (input.share !== null && input.guestCount > 1) {
    return (
      `${input.outletName}: ${greeting}, the bill for table ${input.tableId} is ` +
      `Rs.${input.total} for ${input.guestCount} guests. Your share is Rs.${input.share}. ${thanks}`
    );
  }
  return `${input.outletName}: ${greeting}, your bill for table ${input.tableId} is Rs.${input.total}. ${thanks}`;
}

/** `?&body=` is the form both Android and iOS messaging apps read. */
export function smsHref(phone: string, body: string): string {
  return `sms:${phone}?&body=${encodeURIComponent(body)}`;
}

/** wa.me wants the number as digits only, country code first. */
export function whatsAppHref(phone: string, body: string): string {
  return `https://wa.me/${phone.replace(/\D/g, "")}?text=${encodeURIComponent(body)}`;
}

/** What a phone camera reads from a QR code as "send this SMS": number and text prefilled. */
export function smsQrPayload(phone: string, body: string): string {
  return `SMSTO:${phone}:${body}`;
}

// Characters the GSM 03.38 alphabet can only send as two-character escapes.
const GSM_EXTENDED = /[\^{}\\[\]~|€]/g;
const GSM_BASIC = /^[A-Za-z0-9 @£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà^{}\\[\]~|€]*$/;

/** How many SMS a text costs, so staff can see what a send takes from the daily allowance. */
export function smsSegments(text: string): number {
  if (GSM_BASIC.test(text)) {
    const length = text.length + (text.match(GSM_EXTENDED)?.length ?? 0);
    return length <= 160 ? 1 : Math.ceil(length / 153);
  }
  // Anything else goes as UCS-2, whose units match JavaScript's UTF-16 length (an emoji is two).
  const units = text.length;
  return units <= 70 ? 1 : Math.ceil(units / 67);
}
