import { newId } from "@/lib/ids";
import type { DietaryType } from "@/types/krave";

export const POS_STORAGE_KEY = "krave.pos.v1";
export const POS_SHIFT_STORAGE_KEY = "krave.pos-shift.v1";
export const POS_SEAT_HANDOFF_KEY = "krave.pos-seat-handoff.v1";
export const POS_MAX_QUANTITY = 99;
export const POS_MAX_GUESTS = 50;
export const POS_MAX_NOTE_LENGTH = 120;
export const POS_MAX_GUEST_NAME_LENGTH = 40;
/** Ceiling for any cash figure the cashier types (float, count, tendered), in rupees. */
export const POS_MAX_CASH = 10000000;
/** Off-menu dishes carry this prefix so sync knows to keep the operator's price. */
export const POS_CUSTOM_ITEM_PREFIX = "custom_";
/** Every open table is always kept; settled history fills the rest, newest first. */
export const POS_MAX_STORED_SESSIONS = 200;

/** Upper bound for a restaurant's tax rate, in basis points, matching the owner settings. */
export const POS_MAX_TAX_BPS = 10000;
/** Tables saved before the rate was per restaurant were all billed at 5% GST. */
const LEGACY_TAX_BPS = 500;

/** Service charge is discretionary in India, so it defaults to zero and stays operator-controlled. */
export const POS_MAX_SERVICE_CHARGE_PERCENT = 20;

export const POS_TABLES = [
  { tableId: "T1", label: "T1", seats: 2, zone: "Indoor" },
  { tableId: "T2", label: "T2", seats: 2, zone: "Indoor" },
  { tableId: "T3", label: "T3", seats: 4, zone: "Indoor" },
  { tableId: "T4", label: "T4", seats: 4, zone: "Indoor" },
  { tableId: "T5", label: "T5", seats: 6, zone: "Indoor" },
  { tableId: "G1", label: "G1", seats: 4, zone: "Garden" },
  { tableId: "G2", label: "G2", seats: 4, zone: "Garden" },
  { tableId: "G3", label: "G3", seats: 8, zone: "Garden" },
  { tableId: "B1", label: "B1", seats: 2, zone: "Bar" },
  { tableId: "B2", label: "B2", seats: 2, zone: "Bar" },
  { tableId: "P1", label: "P1", seats: 10, zone: "Private" },
  { tableId: "TK", label: "TK", seats: 1, zone: "Takeaway" },
] as const;

export type PosPaymentMethod = "CASH" | "CARD" | "UPI";
/**
 * A merged table keeps its record for audit but can never take items or be settled again.
 * A released table was freed with nothing to bill (opened by mistake, or every item voided).
 */
export type PosSessionStatus = "OPEN" | "SETTLED" | "MERGED" | "RELEASED";

export interface PosMenuItem {
  itemId: string;
  /** Full name as billed and sent to the kitchen, portion included: "Mutton Biriyani (Half)". */
  name: string;
  /** The dish this portion belongs to, so the counter shows one card per dish. */
  dishId: string;
  dishName: string;
  /** "Half", "Full", "2 pieces"; null for a dish sold one way. */
  portion: string | null;
  /** Whole rupees. */
  price: number;
  categoryName: string;
  dietary: DietaryType;
  bestseller: boolean;
}

/** A restaurant this terminal may bill for, with the dishes it can ring up right now. */
export interface PosOutlet {
  outletId: number;
  name: string;
  locality: string;
  /** GST the restaurant charges, in basis points; 0 when it charges none. */
  taxRateBps: number;
  /** Owners and managers see every bill and the day's takings; a waiter looks one bill up. */
  seesAllSales: boolean;
  /** Printed at the top of the bill; "" when the restaurant has not given them. */
  fssaiNumber: string;
  gstin: string;
  menu: PosMenuItem[];
}

/** What the server could load for the signed-in account when the terminal page was served. */
export type PosCatalog =
  | { status: "signed-out" }
  | { status: "unavailable" }
  | { status: "ready"; outlets: PosOutlet[] };

const POS_MAX_OUTLET_NAME = 120;

function assertOutlet(outletId: number, outletName: string, action: string): string {
  const name = outletName.trim();
  if (!Number.isSafeInteger(outletId) || outletId < 1 || !name || name.length > POS_MAX_OUTLET_NAME) {
    throw new Error(`Select a valid outlet before ${action}.`);
  }
  return name;
}

export interface PosOrderLine {
  lineId: string;
  itemId: string;
  name: string;
  /** Price captured when the guest ordered, so later menu edits never alter an open bill. */
  unitPrice: number;
  quantity: number;
  dietary: DietaryType;
  note: string;
  kotNumber: number | null;
}

export interface PosVoidRecord {
  name: string;
  quantity: number;
  reason: string;
  voidedAt: string;
}

export interface PosPayment {
  method: PosPaymentMethod;
  amountTendered: number;
  changeDue: number;
  settledAt: string;
}

/** Who sits at a seat, so the bill or their share can be texted to them. */
export interface PosGuest {
  /** 1-based, matching "Guest N" in the split. */
  seat: number;
  name: string;
  /** `+91` and ten digits, or null when only a name was taken. */
  phone: string | null;
}

export interface PosCorrection {
  kind: "payment" | "reopen";
  at: string;
  /** What changed, in words for the bill: "Paid by CASH → UPI". */
  detail: string;
  reason: string;
}

export interface PosTableSession {
  sessionId: string;
  outletId: number;
  outletName: string;
  tableId: string;
  guestCount: number;
  serverName: string;
  /** Sorted by seat. A seat above the guest count is kept but not used. */
  guests: PosGuest[];
  /** Captured when the table opens, like line prices, so a settings change never alters an open bill. */
  taxRateBps: number;
  openedAt: string;
  status: PosSessionStatus;
  lines: PosOrderLine[];
  voids: PosVoidRecord[];
  discountPercent: number;
  serviceChargePercent: number;
  nextKotNumber: number;
  payment: PosPayment | null;
  /** Shift the table was opened under, so a Z-report can claim only its own bills. */
  shiftId: string | null;
  /** Every fired ticket is kept verbatim so a reprint shows what the kitchen received. */
  tickets: PosKitchenTicket[];
  mergedIntoSessionId: string | null;
  /** Owner-approved changes to a paid bill, kept so the bill shows what was changed and why. */
  corrections: PosCorrection[];
  /** Server-assigned version this device last synced; 0 means the server has never seen it. */
  revision: number;
}

export interface PosBill {
  itemCount: number;
  subtotal: number;
  discountAmount: number;
  serviceCharge: number;
  cgst: number;
  sgst: number;
  /** Half of the table's rate each, as charged within one state. */
  cgstRateBps: number;
  sgstRateBps: number;
  taxTotal: number;
  roundOff: number;
  grandTotal: number;
  perGuest: number;
}

export interface PosKitchenTicket {
  kotNumber: number;
  tableId: string;
  serverName: string;
  firedAt: string;
  /** Source table when the ticket arrived through a merge, so the kitchen copy stays traceable. */
  mergedFrom: string | null;
  lines: { name: string; quantity: number; note: string; dietary: DietaryType }[];
}

export interface PosShift {
  shiftId: string;
  outletId: number;
  outletName: string;
  openedBy: string;
  openedAt: string;
  openingCash: number;
  closedBy: string | null;
  closedAt: string | null;
  countedCash: number | null;
}

export interface PosZReport {
  shiftId: string;
  outletName: string;
  openedBy: string;
  openedAt: string;
  closedBy: string;
  closedAt: string;
  openingCash: number;
  cashSales: number;
  expectedCash: number;
  countedCash: number;
  cashVariance: number;
  voidCount: number;
  openTablesAtClose: number;
  summary: PosShiftSummary;
}

export interface PosShiftSummary {
  settledBills: number;
  covers: number;
  grossSales: number;
  taxCollected: number;
  discountsGiven: number;
  averageBill: number;
  byPaymentMethod: Record<PosPaymentMethod, number>;
}

export interface PosGuestSplitShare {
  guestIndex: number;
  guestLabel: string;
  itemsSubtotal: number;
  taxAndChargesShare: number;
  payableAmount: number;
}

function isTaxRate(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= POS_MAX_TAX_BPS;
}

/**
 * Non-negative integer division rounded half up. Bill math runs in integer paise through this,
 * because float rupees round some halves the wrong way (2.5% of ₹41.40 is ₹1.035, which
 * `Math.round(x * 100) / 100` turns into ₹1.03).
 */
function divideRounded(numerator: number, denominator: number): number {
  let quotient = Math.floor(numerator / denominator);
  let remainder = numerator - quotient * denominator;
  if (remainder < 0) {
    quotient -= 1;
    remainder += denominator;
  } else if (remainder >= denominator) {
    quotient += 1;
    remainder -= denominator;
  }
  return remainder * 2 >= denominator ? quotient + 1 : quotient;
}

function paiseToRupees(paise: number): number {
  return paise / 100;
}

/**
 * Split a whole amount across integer weights so the parts add up to exactly `total`: each part
 * gets its floor, then the leftover units go to the largest remainders (ties to the earlier
 * guest). BigInt keeps `total × weight` exact for any bill size.
 */
function apportion(total: number, weights: number[]): number[] {
  const weightSum = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0 || weightSum <= 0) return weights.map(() => 0);
  const bigTotal = BigInt(total);
  const bigSum = BigInt(weightSum);
  const parts = weights.map((weight) => {
    const scaled = bigTotal * BigInt(weight);
    return { floor: Number(scaled / bigSum), remainder: scaled % bigSum };
  });
  let leftover = total - parts.reduce((sum, part) => sum + part.floor, 0);
  const byRemainder = parts
    .map((_, index) => index)
    .sort((a, b) =>
      parts[a].remainder === parts[b].remainder
        ? a - b
        : parts[b].remainder > parts[a].remainder
          ? 1
          : -1
    );
  const result = parts.map((part) => part.floor);
  for (const index of byRemainder) {
    if (leftover <= 0) break;
    result[index] += 1;
    leftover -= 1;
  }
  return result;
}

function assertWholePercent(value: number, max: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new Error(`${label} must be a whole percent between 0 and ${max}.`);
  }
  return value;
}

function assertCash(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > POS_MAX_CASH) {
    throw new Error(`${label} must be a whole rupee amount.`);
  }
  return value;
}

function assertQuantity(quantity: number): void {
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > POS_MAX_QUANTITY) {
    throw new Error(`Quantity must be a whole number between 1 and ${POS_MAX_QUANTITY}.`);
  }
}

function assertOpen(session: PosTableSession): void {
  if (session.status === "MERGED") {
    throw new Error("This table was merged into another bill.");
  }
  if (session.status === "RELEASED") {
    throw new Error("This table was released without a bill.");
  }
  if (session.status !== "OPEN") {
    throw new Error("This table is already settled.");
  }
}

/**
 * Seat a table. Pass the current floor so a table that became occupied meanwhile (another
 * terminal's state adopted while the seat dialog was open) is refused instead of getting a
 * second open bill that the floor plan can never reach.
 */
export function openTableSession(
  input: {
    outletId: number;
    outletName: string;
    tableId: string;
    guestCount: number;
    serverName: string;
    taxRateBps: number;
    shiftId?: string | null;
    leadGuest?: { name: string; phone: string };
  },
  floor: readonly PosTableSession[] = []
): PosTableSession {
  const outlet = {
    outletId: input.outletId,
    name: assertOutlet(input.outletId, input.outletName, "opening a table"),
  };
  if (!POS_TABLES.some((table) => table.tableId === input.tableId)) {
    throw new Error("Unknown table.");
  }
  if (
    !Number.isSafeInteger(input.guestCount) ||
    input.guestCount < 1 ||
    input.guestCount > POS_MAX_GUESTS
  ) {
    throw new Error(`Guest count must be between 1 and ${POS_MAX_GUESTS}.`);
  }
  const serverName = input.serverName.trim();
  if (serverName.length < 2 || serverName.length > 40) {
    throw new Error("Enter the steward or server name.");
  }
  if (!isTaxRate(input.taxRateBps)) {
    throw new Error("This restaurant's tax rate is not usable.");
  }
  const occupied = floor.some(
    (candidate) =>
      candidate.status === "OPEN" &&
      candidate.outletId === outlet.outletId &&
      candidate.tableId === input.tableId
  );
  if (occupied) {
    throw new Error(`Table ${input.tableId} is already occupied.`);
  }

  return {
    sessionId: `POS-${newId()}`,
    outletId: outlet.outletId,
    outletName: outlet.name,
    tableId: input.tableId,
    guestCount: input.guestCount,
    serverName,
    guests: input.leadGuest ? guestList([], 1, input.leadGuest) : [],
    taxRateBps: input.taxRateBps,
    openedAt: new Date().toISOString(),
    status: "OPEN",
    lines: [],
    voids: [],
    discountPercent: 0,
    serviceChargePercent: 0,
    nextKotNumber: 1,
    payment: null,
    shiftId: input.shiftId ?? null,
    tickets: [],
    mergedIntoSessionId: null,
    corrections: [],
    revision: 0,
  };
}

/**
 * An Indian mobile number as `+91XXXXXXXXXX`, from how people actually say it: with or without
 * +91, 91 or a leading 0, and with spaces or dashes. Landlines and short numbers give null.
 */
export function normalizeIndianMobile(raw: string): string | null {
  const compact = raw.trim().replace(/[\s\-().]/g, "");
  const match = /^(?:\+91|91|0)?([6-9]\d{9})$/.exec(compact);
  return match ? `+91${match[1]}` : null;
}

function guestList(
  guests: readonly PosGuest[],
  seat: number,
  input: { name: string; phone: string }
): PosGuest[] {
  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length > POS_MAX_GUEST_NAME_LENGTH) {
    throw new Error(`Keep the guest name under ${POS_MAX_GUEST_NAME_LENGTH} characters.`);
  }
  const rawPhone = input.phone.trim();
  const phone = rawPhone ? normalizeIndianMobile(rawPhone) : null;
  if (rawPhone && !phone) {
    throw new Error("Enter a 10-digit Indian mobile number.");
  }
  const others = guests.filter((guest) => guest.seat !== seat);
  // Clearing both fields forgets the guest rather than keeping an empty record.
  if (!name && !phone) return others;
  return [...others, { seat, name, phone }].sort((a, b) => a.seat - b.seat);
}

/** Record or clear the name and mobile number of the guest in one seat. */
export function setTableGuest(
  session: PosTableSession,
  seat: number,
  input: { name: string; phone: string }
): PosTableSession {
  if (session.status !== "OPEN" && session.status !== "SETTLED") {
    throw new Error("This table is no longer on the floor.");
  }
  if (!Number.isSafeInteger(seat) || seat < 1 || seat > session.guestCount) {
    throw new Error(`Pick a guest between 1 and ${session.guestCount}.`);
  }
  return { ...session, guests: guestList(session.guests, seat, input) };
}

export function addItemToSession(
  session: PosTableSession,
  item: PosMenuItem,
  quantity = 1,
  note = ""
): PosTableSession {
  assertOpen(session);
  assertQuantity(quantity);
  const trimmedNote = note.trim().slice(0, POS_MAX_NOTE_LENGTH);

  // Repeat taps merge into the same un-fired line so the kitchen receives one clear ticket row.
  const existing = session.lines.find(
    (line) =>
      line.kotNumber === null && line.itemId === item.itemId && line.note.trim() === trimmedNote
  );

  if (existing) {
    const merged = existing.quantity + quantity;
    assertQuantity(merged);
    return {
      ...session,
      lines: session.lines.map((line) =>
        line.lineId === existing.lineId ? { ...line, quantity: merged } : line
      ),
    };
  }

  return {
    ...session,
    lines: [
      ...session.lines,
      {
        lineId: `L-${newId()}`,
        itemId: item.itemId,
        name: item.name,
        unitPrice: Math.round(item.price),
        quantity,
        dietary: item.dietary,
        note: trimmedNote,
        kotNumber: null,
      },
    ],
  };
}

export function setLineQuantity(
  session: PosTableSession,
  lineId: string,
  quantity: number
): PosTableSession {
  assertOpen(session);
  const line = session.lines.find((candidate) => candidate.lineId === lineId);
  if (!line) {
    throw new Error("Order line not found.");
  }
  if (quantity === 0 && line.kotNumber === null) {
    return { ...session, lines: session.lines.filter((candidate) => candidate.lineId !== lineId) };
  }
  assertQuantity(quantity);

  // Once the kitchen has the ticket, reducing a quantity is a void that needs a reason on record.
  if (line.kotNumber !== null && quantity < line.quantity) {
    throw new Error("Item already sent to kitchen. Use Void to reduce it.");
  }

  return {
    ...session,
    lines: session.lines.map((candidate) =>
      candidate.lineId === lineId ? { ...candidate, quantity } : candidate
    ),
  };
}

export function addCustomItemToSession(
  session: PosTableSession,
  custom: {
    name: string;
    price: number;
    dietary?: DietaryType;
    quantity?: number;
    note?: string;
  }
): PosTableSession {
  const cleanName = custom.name.trim();
  if (cleanName.length < 2 || cleanName.length > 80) {
    throw new Error("Enter a custom dish name (2–80 characters).");
  }
  const cleanPrice = custom.price;
  if (!Number.isSafeInteger(cleanPrice) || cleanPrice < 1 || cleanPrice > 100000) {
    throw new Error("Custom dish price must be a whole rupee amount between ₹1 and ₹1,00,000.");
  }
  const dietary: DietaryType =
    custom.dietary === "non-veg" || custom.dietary === "egg" ? custom.dietary : "veg";
  // A random id, not one derived from the name: non-Latin names ("मसाला चाय", "अदरक चाय")
  // all slug to the same string and would merge into one bill line and KOT row.
  const itemId = `${POS_CUSTOM_ITEM_PREFIX}${newId()}`;
  return addItemToSession(
    session,
    {
      itemId,
      name: cleanName,
      dishId: itemId,
      dishName: cleanName,
      portion: null,
      price: cleanPrice,
      categoryName: "Custom Specials",
      dietary,
      bestseller: false,
    },
    custom.quantity ?? 1,
    custom.note ?? ""
  );
}

/**
 * Store the note exactly as typed (capped): the terminal binds this to a controlled input, so
 * trimming here would eat the space after every word ("no onion" → "noonion"). Notes are
 * trimmed when the ticket is fired.
 */
export function setLineNote(
  session: PosTableSession,
  lineId: string,
  note: string
): PosTableSession {
  assertOpen(session);
  const line = session.lines.find((candidate) => candidate.lineId === lineId);
  if (!line) {
    throw new Error("Order line not found.");
  }
  if (line.kotNumber !== null) {
    throw new Error("Cannot edit cooking note after ticket is sent to kitchen.");
  }
  return {
    ...session,
    lines: session.lines.map((candidate) =>
      candidate.lineId === lineId
        ? { ...candidate, note: note.slice(0, POS_MAX_NOTE_LENGTH) }
        : candidate
    ),
  };
}

export function transferTableSession(
  sessions: PosTableSession[],
  sessionId: string,
  targetTableId: string
): PosTableSession[] {
  if (!POS_TABLES.some((table) => table.tableId === targetTableId)) {
    throw new Error("Select a valid destination table.");
  }
  const source = sessions.find((candidate) => candidate.sessionId === sessionId);
  if (!source || source.status !== "OPEN") {
    throw new Error("Only an open table session can be moved.");
  }
  if (source.tableId === targetTableId) {
    return sessions;
  }
  const occupied = sessions.some(
    (candidate) =>
      candidate.status === "OPEN" &&
      candidate.outletId === source.outletId &&
      candidate.tableId === targetTableId
  );
  if (occupied) {
    throw new Error(`Table ${targetTableId} is already occupied.`);
  }
  return sessions.map((candidate) =>
    candidate.sessionId === sessionId
      ? { ...candidate, tableId: targetTableId }
      : candidate
  );
}

/**
 * Move one open table's order onto another so a party that changed seats pays a single bill.
 * Fired items keep their kitchen history through a copied ticket, but are renumbered into the
 * destination's KOT sequence because a bill may not contain two tickets with the same number.
 * The destination's own discount and service charge stay in force.
 */
export function mergeTableSessions(
  sessions: PosTableSession[],
  sourceSessionId: string,
  targetSessionId: string
): PosTableSession[] {
  if (sourceSessionId === targetSessionId) {
    throw new Error("Select two different tables to merge.");
  }
  const source = sessions.find((candidate) => candidate.sessionId === sourceSessionId);
  const target = sessions.find((candidate) => candidate.sessionId === targetSessionId);
  if (!source || !target) {
    throw new Error("Both tables must still be on the floor.");
  }
  if (source.status !== "OPEN" || target.status !== "OPEN") {
    throw new Error("Only open tables can be merged.");
  }
  if (source.outletId !== target.outletId) {
    throw new Error("Tables from different outlets cannot be merged.");
  }
  if (source.lines.length === 0) {
    throw new Error("The source table has nothing to merge.");
  }

  // Each distinct source KOT becomes one new ticket on the destination, in firing order.
  const renumbered = new Map<number, number>();
  let nextKotNumber = target.nextKotNumber;
  for (const line of source.lines) {
    if (line.kotNumber !== null && !renumbered.has(line.kotNumber)) {
      renumbered.set(line.kotNumber, nextKotNumber);
      nextKotNumber += 1;
    }
  }

  const movedLines = source.lines.map((line) => ({
    ...line,
    kotNumber: line.kotNumber === null ? null : renumbered.get(line.kotNumber) ?? null,
  }));

  const movedTickets = source.tickets.flatMap((ticket) => {
    const kotNumber = renumbered.get(ticket.kotNumber);
    if (kotNumber === undefined) return [];
    return [
      {
        ...ticket,
        kotNumber,
        tableId: target.tableId,
        mergedFrom: `${source.tableId} · KOT ${ticket.kotNumber}`,
      },
    ];
  });

  const mergedTarget: PosTableSession = {
    ...target,
    guestCount: Math.min(target.guestCount + source.guestCount, POS_MAX_GUESTS),
    // The source party takes the seats after the destination's own guests.
    guests: [
      ...target.guests.filter((guest) => guest.seat <= target.guestCount),
      ...source.guests
        .map((guest) => ({ ...guest, seat: guest.seat + target.guestCount }))
        .filter((guest) => guest.seat <= POS_MAX_GUESTS),
    ].sort((a, b) => a.seat - b.seat),
    lines: [...target.lines, ...movedLines],
    voids: [...target.voids, ...source.voids],
    tickets: [...target.tickets, ...movedTickets],
    nextKotNumber,
  };

  const mergedSource: PosTableSession = {
    ...source,
    status: "MERGED",
    guests: [],
    lines: [],
    voids: [],
    tickets: [],
    mergedIntoSessionId: target.sessionId,
  };

  return sessions.map((candidate) => {
    if (candidate.sessionId === target.sessionId) return mergedTarget;
    if (candidate.sessionId === source.sessionId) return mergedSource;
    return candidate;
  });
}

/**
 * Apportion the table bill across guests based on item assignments (`0` = shared equally,
 * `1..guestCount` = assigned to that specific guest), including proportional discount,
 * service charge, and GST. Shares are whole rupees that add up to exactly the bill's grand
 * total (and item subtotals to the bill subtotal), so the table never collects a rupee more
 * or less than the printed bill.
 */
export function calculateItemizedSplit(
  session: PosTableSession,
  lineAssignments: Record<string, number> = {}
): PosGuestSplitShare[] {
  const guests = Math.max(1, session.guestCount);
  const bill = computeBillPaise(session);
  // Weights are scaled by the guest count so an equally shared line stays an integer.
  const weights = Array.from({ length: guests }, () => 0);

  for (const line of session.lines) {
    const lineTotal = line.unitPrice * line.quantity;
    const assigned = lineAssignments[line.lineId] ?? 0;
    if (Number.isSafeInteger(assigned) && assigned >= 1 && assigned <= guests) {
      weights[assigned - 1] += lineTotal * guests;
    } else {
      for (let i = 0; i < guests; i += 1) {
        weights[i] += lineTotal;
      }
    }
  }

  const itemsPaise = apportion(bill.subtotal, weights);
  const payableRupees = apportion(bill.grandTotalRupees, weights);

  return weights.map((_, index) => ({
    guestIndex: index + 1,
    guestLabel:
      session.guests.find((guest) => guest.seat === index + 1)?.name || `Guest ${index + 1}`,
    itemsSubtotal: paiseToRupees(itemsPaise[index]),
    taxAndChargesShare: paiseToRupees(payableRupees[index] * 100 - itemsPaise[index]),
    payableAmount: payableRupees[index],
  }));
}

/**
 * Void a line, or only `quantity` of it (1 of 3 naan) so the rest stays fired on its original
 * KOT. Every void is recorded with its reason for the shift report.
 */
export function voidLine(
  session: PosTableSession,
  lineId: string,
  reason: string,
  quantity?: number
): PosTableSession {
  assertOpen(session);
  const line = session.lines.find((candidate) => candidate.lineId === lineId);
  if (!line) {
    throw new Error("Order line not found.");
  }
  const trimmedReason = reason.trim();
  if (trimmedReason.length < 3 || trimmedReason.length > 120) {
    throw new Error("Enter a void reason (minimum 3 characters).");
  }
  const voidQuantity = quantity ?? line.quantity;
  if (!Number.isSafeInteger(voidQuantity) || voidQuantity < 1 || voidQuantity > line.quantity) {
    throw new Error(`Void between 1 and ${line.quantity} of ${line.name}.`);
  }
  const remaining = line.quantity - voidQuantity;

  return {
    ...session,
    lines:
      remaining === 0
        ? session.lines.filter((candidate) => candidate.lineId !== lineId)
        : session.lines.map((candidate) =>
            candidate.lineId === lineId ? { ...candidate, quantity: remaining } : candidate
          ),
    voids: [
      ...session.voids,
      {
        name: line.name,
        quantity: voidQuantity,
        reason: trimmedReason,
        voidedAt: new Date().toISOString(),
      },
    ],
  };
}

/**
 * Free a table that has nothing to bill: opened by mistake, or every item voided. Without this
 * such a table could be neither settled nor merged away and stayed occupied for good. The
 * record (and any voids on it) stays for the shift report.
 */
export function releaseTable(session: PosTableSession): PosTableSession {
  assertOpen(session);
  if (session.lines.length > 0) {
    throw new Error("Void or settle the items on this table before releasing it.");
  }
  return { ...session, status: "RELEASED" };
}

/** Correct the waiter on a table; tickets already sent keep the name they were sent with. */
export function setTableServer(session: PosTableSession, serverName: string): PosTableSession {
  assertOpen(session);
  const name = serverName.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 40) {
    throw new Error("Enter the steward or server name.");
  }
  return { ...session, serverName: name };
}

const MAX_CORRECTION_REASON = 120;

/**
 * A paid bill can be corrected only while its shift is still open: once a shift is closed its
 * Z-report has been counted against the cash drawer and must not change underneath it.
 */
function assertCorrectable(session: PosTableSession, openShiftId: string | null): PosPayment {
  if (session.status !== "SETTLED" || !session.payment) {
    throw new Error("Only a paid bill can be corrected.");
  }
  if (session.shiftId && session.shiftId !== openShiftId) {
    throw new Error("This bill belongs to a closed shift, so it can no longer be changed.");
  }
  return session.payment;
}

/** Owner-approved: the guest paid another way than the bill was settled as. */
export function changeSettledPayment(
  session: PosTableSession,
  method: PosPaymentMethod,
  reason: string,
  openShiftId: string | null
): PosTableSession {
  const payment = assertCorrectable(session, openShiftId);
  if (method === payment.method) {
    throw new Error(`This bill is already marked as ${method}.`);
  }
  const total = calculatePosBill(session).grandTotal;
  return {
    ...session,
    // What was handed over in cash is not known after the fact, so the bill records it as exact.
    payment: { ...payment, method, amountTendered: total, changeDue: 0 },
    corrections: [
      ...session.corrections,
      {
        kind: "payment",
        at: new Date().toISOString(),
        detail: `Paid by ${payment.method} → ${method}`,
        reason: reason.trim().slice(0, MAX_CORRECTION_REASON),
      },
    ],
  };
}

/** Owner-approved: put a paid bill back on its table, e.g. when the guests order more. */
export function reopenSettledSession(
  session: PosTableSession,
  reason: string,
  openShiftId: string | null,
  floor: readonly PosTableSession[]
): PosTableSession {
  const payment = assertCorrectable(session, openShiftId);
  const why = reason.trim();
  if (why.length < 3) {
    throw new Error("Say why the bill is being reopened (at least 3 characters).");
  }
  const occupied = floor.some(
    (candidate) =>
      candidate.status === "OPEN" &&
      candidate.outletId === session.outletId &&
      candidate.tableId === session.tableId
  );
  if (occupied) {
    throw new Error(`Table ${session.tableId} has new guests. Free it before reopening this bill.`);
  }
  return {
    ...session,
    status: "OPEN",
    payment: null,
    corrections: [
      ...session.corrections,
      {
        kind: "reopen",
        at: new Date().toISOString(),
        detail: `Reopened (was paid ₹${calculatePosBill(session).grandTotal} by ${payment.method})`,
        reason: why.slice(0, MAX_CORRECTION_REASON),
      },
    ],
  };
}

export function setSessionCharges(
  session: PosTableSession,
  charges: { discountPercent?: number; serviceChargePercent?: number; guestCount?: number }
): PosTableSession {
  assertOpen(session);
  const next = { ...session };

  if (charges.discountPercent !== undefined) {
    // Whole percents only: 12.5% used to round silently to 13%, and the server stores an integer.
    next.discountPercent = assertWholePercent(charges.discountPercent, 100, "Discount");
  }

  if (charges.serviceChargePercent !== undefined) {
    next.serviceChargePercent = assertWholePercent(
      charges.serviceChargePercent,
      POS_MAX_SERVICE_CHARGE_PERCENT,
      "Service charge"
    );
  }

  if (charges.guestCount !== undefined) {
    if (
      !Number.isSafeInteger(charges.guestCount) ||
      charges.guestCount < 1 ||
      charges.guestCount > POS_MAX_GUESTS
    ) {
      throw new Error(`Guest count must be between 1 and ${POS_MAX_GUESTS}.`);
    }
    next.guestCount = charges.guestCount;
  }

  return next;
}

export function sendPendingToKitchen(session: PosTableSession): {
  session: PosTableSession;
  ticket: PosKitchenTicket;
} {
  assertOpen(session);
  const pending = session.lines.filter((line) => line.kotNumber === null);
  if (pending.length === 0) {
    throw new Error("No new items to send to the kitchen.");
  }

  const kotNumber = session.nextKotNumber;
  const firedAt = new Date().toISOString();
  const ticket: PosKitchenTicket = {
    kotNumber,
    tableId: session.tableId,
    serverName: session.serverName,
    firedAt,
    mergedFrom: null,
    lines: pending.map((line) => ({
      name: line.name,
      quantity: line.quantity,
      note: line.note.trim(),
      dietary: line.dietary,
    })),
  };

  return {
    session: {
      ...session,
      nextKotNumber: kotNumber + 1,
      lines: session.lines.map((line) =>
        line.kotNumber === null ? { ...line, note: line.note.trim(), kotNumber } : line
      ),
      tickets: [...session.tickets, ticket],
    },
    ticket,
  };
}

/** Reprints are served from the stored ticket, so a later void never rewrites kitchen history. */
export function findKitchenTicket(
  session: PosTableSession,
  kotNumber: number
): PosKitchenTicket {
  const ticket = session.tickets.find((candidate) => candidate.kotNumber === kotNumber);
  if (!ticket) {
    throw new Error(`KOT ${kotNumber} was not found on this table.`);
  }
  return ticket;
}

/** The bill in integer paise; the grand total is also given in whole rupees, as collected. */
function computeBillPaise(session: PosTableSession) {
  const subtotal =
    session.lines.reduce((total, line) => total + line.unitPrice * line.quantity, 0) * 100;
  const discountAmount = divideRounded(subtotal * session.discountPercent, 100);
  const discountedBase = Math.max(0, subtotal - discountAmount);
  const serviceCharge = divideRounded(discountedBase * session.serviceChargePercent, 100);
  const taxableValue = discountedBase + serviceCharge;
  const cgstRateBps = Math.floor(session.taxRateBps / 2);
  const sgstRateBps = session.taxRateBps - cgstRateBps;
  const cgst = divideRounded(taxableValue * cgstRateBps, 10000);
  const sgst = divideRounded(taxableValue * sgstRateBps, 10000);
  const payable = taxableValue + cgst + sgst;
  const grandTotalRupees = divideRounded(payable, 100);
  return {
    subtotal,
    discountAmount,
    serviceCharge,
    cgst,
    sgst,
    cgstRateBps,
    sgstRateBps,
    payable,
    grandTotalRupees,
  };
}

/** Compute the printable bill. Tax applies after discount and on any service charge. */
export function calculatePosBill(session: PosTableSession): PosBill {
  const itemCount = session.lines.reduce((total, line) => total + line.quantity, 0);
  const paise = computeBillPaise(session);
  const grandTotal = paise.grandTotalRupees;

  return {
    itemCount,
    subtotal: paiseToRupees(paise.subtotal),
    discountAmount: paiseToRupees(paise.discountAmount),
    serviceCharge: paiseToRupees(paise.serviceCharge),
    cgst: paiseToRupees(paise.cgst),
    sgst: paiseToRupees(paise.sgst),
    cgstRateBps: paise.cgstRateBps,
    sgstRateBps: paise.sgstRateBps,
    taxTotal: paiseToRupees(paise.cgst + paise.sgst),
    roundOff: paiseToRupees(grandTotal * 100 - paise.payable),
    grandTotal,
    perGuest: session.guestCount > 0 ? Math.ceil(grandTotal / session.guestCount) : grandTotal,
  };
}

export function settleSession(
  session: PosTableSession,
  method: PosPaymentMethod,
  amountTendered: number
): PosTableSession {
  assertOpen(session);
  if (session.lines.length === 0) {
    throw new Error("Add items before settling the bill.");
  }
  if (session.lines.some((line) => line.kotNumber === null)) {
    throw new Error("Send all pending items to the kitchen before settling.");
  }

  const bill = calculatePosBill(session);
  // Cash is counted in whole rupees; 100.5 used to be recorded silently as ₹100 tendered.
  const tendered = method === "CASH" ? amountTendered : bill.grandTotal;
  if (
    !Number.isSafeInteger(tendered) ||
    tendered < bill.grandTotal ||
    tendered > Math.max(POS_MAX_CASH, bill.grandTotal)
  ) {
    throw new Error(`Amount tendered must be a whole rupee amount of at least ₹${bill.grandTotal}.`);
  }

  return {
    ...session,
    status: "SETTLED",
    payment: {
      method,
      amountTendered: tendered,
      changeDue: tendered - bill.grandTotal,
      settledAt: new Date().toISOString(),
    },
  };
}

export function summarizeShift(sessions: PosTableSession[]): PosShiftSummary {
  const settled = sessions.filter((session) => session.status === "SETTLED");
  const byPaymentMethod: Record<PosPaymentMethod, number> = { CASH: 0, CARD: 0, UPI: 0 };
  let grossSales = 0;
  let taxPaise = 0;
  let discountPaise = 0;
  let covers = 0;

  for (const session of settled) {
    const bill = computeBillPaise(session);
    grossSales += bill.grandTotalRupees;
    taxPaise += bill.cgst + bill.sgst;
    discountPaise += bill.discountAmount;
    covers += session.guestCount;
    if (session.payment) {
      byPaymentMethod[session.payment.method] += bill.grandTotalRupees;
    }
  }

  return {
    settledBills: settled.length,
    covers,
    grossSales,
    taxCollected: paiseToRupees(taxPaise),
    discountsGiven: paiseToRupees(discountPaise),
    averageBill: settled.length ? divideRounded(grossSales, settled.length) : 0,
    byPaymentMethod,
  };
}

export function openShift(input: {
  outletId: number;
  outletName: string;
  openedBy: string;
  openingCash: number;
}): PosShift {
  const outlet = {
    outletId: input.outletId,
    name: assertOutlet(input.outletId, input.outletName, "opening a shift"),
  };
  const openedBy = input.openedBy.trim();
  if (openedBy.length < 2 || openedBy.length > 40) {
    throw new Error("Enter the name of the cashier opening the shift.");
  }
  const openingCash = assertCash(input.openingCash, "Opening cash float");

  return {
    shiftId: `SHIFT-${newId()}`,
    outletId: outlet.outletId,
    outletName: outlet.name,
    openedBy,
    openedAt: new Date().toISOString(),
    openingCash,
    closedBy: null,
    closedAt: null,
    countedCash: null,
  };
}

/**
 * Bills belong to the shift they were opened under. Tables opened before any shift existed
 * are claimed by outlet and settlement time so an earlier session is not silently dropped.
 */
export function getShiftSessions(
  shift: PosShift,
  sessions: PosTableSession[]
): PosTableSession[] {
  const openedAt = Date.parse(shift.openedAt);
  const closedAt = shift.closedAt ? Date.parse(shift.closedAt) : Number.POSITIVE_INFINITY;

  return sessions.filter((session) => {
    if (session.outletId !== shift.outletId || session.status === "MERGED") return false;
    if (session.shiftId) return session.shiftId === shift.shiftId;
    const stamp = Date.parse(session.payment?.settledAt ?? session.openedAt);
    return Number.isFinite(stamp) && stamp >= openedAt && stamp <= closedAt;
  });
}

export function closeShift(
  shift: PosShift,
  sessions: PosTableSession[],
  input: { closedBy: string; countedCash: number }
): { shift: PosShift; report: PosZReport } {
  if (shift.closedAt) {
    throw new Error("This shift is already closed.");
  }
  const closedBy = input.closedBy.trim();
  if (closedBy.length < 2 || closedBy.length > 40) {
    throw new Error("Enter the name of the cashier closing the shift.");
  }
  const countedCash = assertCash(input.countedCash, "Counted cash");

  const closed: PosShift = {
    ...shift,
    closedBy,
    countedCash,
    closedAt: new Date().toISOString(),
  };

  const claimed = getShiftSessions(closed, sessions);
  const summary = summarizeShift(claimed);
  const expectedCash = shift.openingCash + summary.byPaymentMethod.CASH;

  return {
    shift: closed,
    report: {
      shiftId: closed.shiftId,
      outletName: closed.outletName,
      openedBy: closed.openedBy,
      openedAt: closed.openedAt,
      closedBy,
      closedAt: closed.closedAt!,
      openingCash: closed.openingCash,
      cashSales: summary.byPaymentMethod.CASH,
      expectedCash,
      countedCash,
      cashVariance: countedCash - expectedCash,
      voidCount: claimed.reduce((total, session) => total + session.voids.length, 0),
      openTablesAtClose: claimed.filter((session) => session.status === "OPEN").length,
      summary,
    },
  };
}

export function restorePosShift(serialized: string | null): PosShift | null {
  try {
    const parsed: unknown = JSON.parse(serialized || "null");
    if (!isRecord(parsed)) return null;
    const { shiftId, outletId, outletName, openedBy, openedAt, openingCash } = parsed;
    if (
      typeof shiftId !== "string" ||
      !shiftId.startsWith("SHIFT-") ||
      typeof outletId !== "number" ||
      typeof outletName !== "string" ||
      typeof openedBy !== "string" ||
      typeof openedAt !== "string" ||
      !Number.isFinite(Date.parse(openedAt)) ||
      !Number.isSafeInteger(openingCash) ||
      (openingCash as number) < 0
    ) {
      return null;
    }
    // Only an unfinished shift is worth restoring; a closed one has already produced its report.
    if (parsed.closedAt) return null;

    return {
      shiftId,
      outletId,
      outletName,
      openedBy,
      openedAt,
      openingCash: openingCash as number,
      closedBy: null,
      closedAt: null,
      countedCash: null,
    };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Rebuild saved sessions from browser storage, discarding anything malformed.
 * Stored prices are intentionally trusted because a bill must keep the price
 * the guest was quoted, even if the menu changed afterwards.
 */
export function restorePosSessions(serialized: string | null): PosTableSession[] {
  try {
    const parsed: unknown = JSON.parse(serialized || "[]");
    if (!Array.isArray(parsed)) return [];
    return keepOpenAndNewest(parsed.flatMap(restorePosSession));
  } catch {
    return [];
  }
}

/**
 * Sessions are appended over a terminal's lifetime, so capping by array position kept the
 * oldest bills and dropped the newest, open tables included. Keep every open table, fill the
 * rest with the most recent closed ones, and preserve the original order.
 */
function keepOpenAndNewest(sessions: PosTableSession[]): PosTableSession[] {
  if (sessions.length <= POS_MAX_STORED_SESSIONS) return sessions;
  const closedRoom = Math.max(
    0,
    POS_MAX_STORED_SESSIONS - sessions.filter((session) => session.status === "OPEN").length
  );
  const recency = (session: PosTableSession) => {
    const settledAt = Date.parse(session.payment?.settledAt ?? "");
    return Number.isFinite(settledAt) ? settledAt : Date.parse(session.openedAt);
  };
  const keptClosed = new Set(
    sessions
      .filter((session) => session.status !== "OPEN")
      .sort((a, b) => recency(b) - recency(a))
      .slice(0, closedRoom)
  );
  return sessions.filter((session) => session.status === "OPEN" || keptClosed.has(session));
}

function restoreCorrections(raw: unknown): PosCorrection[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): PosCorrection[] =>
    isRecord(entry) &&
    (entry.kind === "payment" || entry.kind === "reopen") &&
    typeof entry.at === "string" &&
    Number.isFinite(Date.parse(entry.at)) &&
    typeof entry.detail === "string" &&
    typeof entry.reason === "string"
      ? [
          {
            kind: entry.kind,
            at: entry.at,
            detail: entry.detail.slice(0, 160),
            reason: entry.reason.slice(0, MAX_CORRECTION_REASON),
          },
        ]
      : []
  );
}

/** Malformed entries are dropped one by one, so a bad phone never costs the table its bill. */
function restoreGuests(raw: unknown): PosGuest[] {
  if (!Array.isArray(raw)) return [];
  const bySeat = new Map<number, PosGuest>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const { seat, name, phone } = entry;
    if (!Number.isSafeInteger(seat) || (seat as number) < 1 || (seat as number) > POS_MAX_GUESTS) {
      continue;
    }
    if (bySeat.has(seat as number)) continue;
    const cleanName =
      typeof name === "string" ? name.trim().slice(0, POS_MAX_GUEST_NAME_LENGTH) : "";
    const cleanPhone = typeof phone === "string" ? normalizeIndianMobile(phone) : null;
    if (!cleanName && !cleanPhone) continue;
    bySeat.set(seat as number, { seat: seat as number, name: cleanName, phone: cleanPhone });
  }
  return [...bySeat.values()].sort((a, b) => a.seat - b.seat);
}

function restorePosSession(entry: unknown): PosTableSession[] {
  if (!isRecord(entry)) return [];
  const {
    sessionId,
    outletId,
    outletName,
    tableId,
    guestCount,
    serverName,
    guests,
    taxRateBps,
    openedAt,
    status,
    lines,
    voids,
    discountPercent,
    serviceChargePercent,
    nextKotNumber,
    payment,
    shiftId,
    tickets,
    mergedIntoSessionId,
    corrections,
    revision,
  } = entry;

  if (
    typeof sessionId !== "string" ||
    !sessionId.startsWith("POS-") ||
    typeof outletId !== "number" ||
    typeof outletName !== "string" ||
    typeof tableId !== "string" ||
    !POS_TABLES.some((table) => table.tableId === tableId) ||
    !Number.isSafeInteger(guestCount) ||
    typeof serverName !== "string" ||
    typeof openedAt !== "string" ||
    !Number.isFinite(Date.parse(openedAt)) ||
    (status !== "OPEN" && status !== "SETTLED" && status !== "MERGED" && status !== "RELEASED") ||
    !Array.isArray(lines)
  ) {
    return [];
  }

  const restoredLines = lines.flatMap((rawLine): PosOrderLine[] => {
    if (!isRecord(rawLine)) return [];
    const { lineId, itemId, name, unitPrice, quantity, dietary, note, kotNumber } = rawLine;
    if (
      typeof lineId !== "string" ||
      typeof itemId !== "string" ||
      typeof name !== "string" ||
      !Number.isSafeInteger(unitPrice) ||
      (unitPrice as number) < 0 ||
      !Number.isSafeInteger(quantity) ||
      (quantity as number) < 1 ||
      (quantity as number) > POS_MAX_QUANTITY ||
      (dietary !== "veg" && dietary !== "non-veg" && dietary !== "egg") ||
      (kotNumber !== null && !Number.isSafeInteger(kotNumber))
    ) {
      return [];
    }
    return [
      {
        lineId,
        itemId,
        name,
        unitPrice: unitPrice as number,
        quantity: quantity as number,
        dietary,
        note: typeof note === "string" ? note.slice(0, POS_MAX_NOTE_LENGTH) : "",
        kotNumber: kotNumber as number | null,
      },
    ];
  });

  const restoredPayment: PosPayment | null =
    isRecord(payment) &&
    (payment.method === "CASH" || payment.method === "CARD" || payment.method === "UPI") &&
    Number.isSafeInteger(payment.amountTendered) &&
    Number.isSafeInteger(payment.changeDue) &&
    typeof payment.settledAt === "string"
      ? {
          method: payment.method,
          amountTendered: payment.amountTendered as number,
          changeDue: payment.changeDue as number,
          settledAt: payment.settledAt,
        }
      : null;

  if (status === "SETTLED" && !restoredPayment) return [];

  const restoredTickets: PosKitchenTicket[] = Array.isArray(tickets)
    ? tickets.flatMap((rawTicket): PosKitchenTicket[] => {
        if (!isRecord(rawTicket)) return [];
        const { kotNumber, firedAt, mergedFrom, lines: ticketLines } = rawTicket;
        if (
          !Number.isSafeInteger(kotNumber) ||
          typeof firedAt !== "string" ||
          !Number.isFinite(Date.parse(firedAt)) ||
          !Array.isArray(ticketLines)
        ) {
          return [];
        }
        return [
          {
            kotNumber: kotNumber as number,
            tableId,
            serverName,
            firedAt,
            mergedFrom: typeof mergedFrom === "string" ? mergedFrom : null,
            lines: ticketLines.flatMap((rawLine) =>
              isRecord(rawLine) &&
              typeof rawLine.name === "string" &&
              Number.isSafeInteger(rawLine.quantity) &&
              (rawLine.dietary === "veg" ||
                rawLine.dietary === "non-veg" ||
                rawLine.dietary === "egg")
                ? [
                    {
                      name: rawLine.name,
                      quantity: rawLine.quantity as number,
                      note: typeof rawLine.note === "string" ? rawLine.note.slice(0, POS_MAX_NOTE_LENGTH) : "",
                      dietary: rawLine.dietary,
                    },
                  ]
                : []
            ),
          },
        ];
      })
    : [];

  return [
    {
      sessionId,
      outletId,
      outletName,
      tableId,
      guestCount: Math.min(Math.max(guestCount as number, 1), POS_MAX_GUESTS),
      serverName,
      guests: restoreGuests(guests),
      taxRateBps: isTaxRate(taxRateBps) ? taxRateBps : LEGACY_TAX_BPS,
      openedAt,
      status,
      lines: restoredLines,
      voids: Array.isArray(voids)
        ? voids.flatMap((rawVoid): PosVoidRecord[] =>
            isRecord(rawVoid) &&
            typeof rawVoid.name === "string" &&
            Number.isSafeInteger(rawVoid.quantity) &&
            typeof rawVoid.reason === "string" &&
            typeof rawVoid.voidedAt === "string"
              ? [
                  {
                    name: rawVoid.name,
                    quantity: rawVoid.quantity as number,
                    reason: rawVoid.reason,
                    voidedAt: rawVoid.voidedAt,
                  },
                ]
              : []
          )
        : [],
      discountPercent:
        typeof discountPercent === "number"
          ? Math.min(Math.max(Math.round(discountPercent), 0), 100)
          : 0,
      serviceChargePercent:
        typeof serviceChargePercent === "number"
          ? Math.min(
              Math.max(Math.round(serviceChargePercent), 0),
              POS_MAX_SERVICE_CHARGE_PERCENT
            )
          : 0,
      nextKotNumber: Number.isSafeInteger(nextKotNumber)
        ? Math.max(nextKotNumber as number, 1)
        : 1,
      payment: restoredPayment,
      shiftId: typeof shiftId === "string" && shiftId.startsWith("SHIFT-") ? shiftId : null,
      tickets: restoredTickets,
      mergedIntoSessionId:
        typeof mergedIntoSessionId === "string" && mergedIntoSessionId.startsWith("POS-")
          ? mergedIntoSessionId
          : null,
      corrections: restoreCorrections(corrections),
      revision:
        Number.isSafeInteger(revision) && (revision as number) >= 0
          ? (revision as number)
          : 0,
    },
  ];
}
