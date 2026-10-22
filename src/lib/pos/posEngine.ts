import { RESTAURANTS_DATA } from "@/data/zomatoReconstructedData";
import { newId } from "@/lib/ids";
import type { DietaryType } from "@/types/krave";

export const POS_STORAGE_KEY = "krave.pos.v1";
export const POS_SHIFT_STORAGE_KEY = "krave.pos-shift.v1";
export const POS_SEAT_HANDOFF_KEY = "krave.pos-seat-handoff.v1";
export const POS_MAX_QUANTITY = 99;
export const POS_MAX_GUESTS = 50;

/** Indian restaurant GST is split into equal CGST and SGST halves on the taxable value. */
export const POS_CGST_RATE = 0.025;
export const POS_SGST_RATE = 0.025;

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
/** A merged table keeps its record for audit but can never take items or be settled again. */
export type PosSessionStatus = "OPEN" | "SETTLED" | "MERGED";

export interface PosMenuItem {
  itemId: string;
  name: string;
  price: number;
  categoryName: string;
  dietary: DietaryType;
  bestseller: boolean;
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

export interface PosTableSession {
  sessionId: string;
  outletId: number;
  outletName: string;
  tableId: string;
  guestCount: number;
  serverName: string;
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

function roundToPaise(value: number): number {
  return Math.round(value * 100) / 100;
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
  if (session.status !== "OPEN") {
    throw new Error("This table is already settled.");
  }
}

export function getPosOutlets() {
  return RESTAURANTS_DATA.map((restaurant) => ({
    outletId: restaurant.resId,
    name: restaurant.name,
    locality: restaurant.locality,
  }));
}

/** Flatten an outlet's nested catalog into the flat list a billing terminal taps through. */
export function getPosMenu(outletId: number): PosMenuItem[] {
  const restaurant = RESTAURANTS_DATA.find((candidate) => candidate.resId === outletId);
  if (!restaurant) {
    throw new Error("Unknown outlet.");
  }
  return restaurant.menus.flatMap((menu) =>
    menu.categories.flatMap((category) =>
      category.items.map((item) => ({
        itemId: item.id,
        name: item.name,
        price: Math.round(item.price),
        categoryName: category.name,
        dietary: item.dietary,
        bestseller: Boolean(item.bestseller),
      }))
    )
  );
}

export function openTableSession(input: {
  outletId: number;
  tableId: string;
  guestCount: number;
  serverName: string;
  shiftId?: string | null;
}): PosTableSession {
  const outlet = getPosOutlets().find((candidate) => candidate.outletId === input.outletId);
  if (!outlet) {
    throw new Error("Select a valid outlet before opening a table.");
  }
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

  return {
    sessionId: `POS-${newId()}`,
    outletId: outlet.outletId,
    outletName: outlet.name,
    tableId: input.tableId,
    guestCount: input.guestCount,
    serverName,
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
    revision: 0,
  };
}

export function addItemToSession(
  session: PosTableSession,
  item: PosMenuItem,
  quantity = 1,
  note = ""
): PosTableSession {
  assertOpen(session);
  assertQuantity(quantity);
  const trimmedNote = note.trim().slice(0, 120);

  // Repeat taps merge into the same un-fired line so the kitchen receives one clear ticket row.
  const existing = session.lines.find(
    (line) => line.kotNumber === null && line.itemId === item.itemId && line.note === trimmedNote
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
  const cleanPrice = Math.round(custom.price);
  if (!Number.isSafeInteger(cleanPrice) || cleanPrice < 1 || cleanPrice > 100000) {
    throw new Error("Custom dish price must be a whole rupee amount between ₹1 and ₹1,00,000.");
  }
  const dietary: DietaryType =
    custom.dietary === "non-veg" || custom.dietary === "egg" ? custom.dietary : "veg";
  const slug = cleanName.toLowerCase().replace(/[^a-z0-9]+/g, "_");
  return addItemToSession(
    session,
    {
      itemId: `custom_${slug}_${cleanPrice}`,
      name: cleanName,
      price: cleanPrice,
      categoryName: "Custom Specials",
      dietary,
      bestseller: false,
    },
    custom.quantity ?? 1,
    custom.note ?? ""
  );
}

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
        ? { ...candidate, note: note.trim().slice(0, 120) }
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
    lines: [...target.lines, ...movedLines],
    voids: [...target.voids, ...source.voids],
    tickets: [...target.tickets, ...movedTickets],
    nextKotNumber,
  };

  const mergedSource: PosTableSession = {
    ...source,
    status: "MERGED",
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
 * service charge, and GST.
 */
export function calculateItemizedSplit(
  session: PosTableSession,
  lineAssignments: Record<string, number> = {}
): PosGuestSplitShare[] {
  const guests = Math.max(1, session.guestCount);
  const bill = calculatePosBill(session);
  const rawSubtotals = Array.from({ length: guests }, () => 0);

  for (const line of session.lines) {
    const lineTotal = line.unitPrice * line.quantity;
    const assigned = lineAssignments[line.lineId] ?? 0;
    if (assigned >= 1 && assigned <= guests) {
      rawSubtotals[assigned - 1] += lineTotal;
    } else {
      const equalShare = lineTotal / guests;
      for (let i = 0; i < guests; i += 1) {
        rawSubtotals[i] += equalShare;
      }
    }
  }

  const multiplier = bill.subtotal > 0 ? bill.grandTotal / bill.subtotal : 0;

  return rawSubtotals.map((sub, index) => {
    const itemsSubtotal = roundToPaise(sub);
    const exactPayable = sub * multiplier;
    const payableAmount = Math.round(exactPayable);
    return {
      guestIndex: index + 1,
      guestLabel: `Guest ${index + 1}`,
      itemsSubtotal,
      taxAndChargesShare: roundToPaise(exactPayable - itemsSubtotal),
      payableAmount,
    };
  });
}

export function voidLine(
  session: PosTableSession,
  lineId: string,
  reason: string
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

  return {
    ...session,
    lines: session.lines.filter((candidate) => candidate.lineId !== lineId),
    voids: [
      ...session.voids,
      {
        name: line.name,
        quantity: line.quantity,
        reason: trimmedReason,
        voidedAt: new Date().toISOString(),
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
    const discount = Math.round(charges.discountPercent);
    if (!Number.isFinite(discount) || discount < 0 || discount > 100) {
      throw new Error("Discount must be between 0 and 100 percent.");
    }
    next.discountPercent = discount;
  }

  if (charges.serviceChargePercent !== undefined) {
    const serviceCharge = Math.round(charges.serviceChargePercent);
    if (
      !Number.isFinite(serviceCharge) ||
      serviceCharge < 0 ||
      serviceCharge > POS_MAX_SERVICE_CHARGE_PERCENT
    ) {
      throw new Error(`Service charge must be between 0 and ${POS_MAX_SERVICE_CHARGE_PERCENT} percent.`);
    }
    next.serviceChargePercent = serviceCharge;
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
      note: line.note,
      dietary: line.dietary,
    })),
  };

  return {
    session: {
      ...session,
      nextKotNumber: kotNumber + 1,
      lines: session.lines.map((line) =>
        line.kotNumber === null ? { ...line, kotNumber } : line
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

/** Compute the printable bill. Tax applies after discount and on any service charge. */
export function calculatePosBill(session: PosTableSession): PosBill {
  const itemCount = session.lines.reduce((total, line) => total + line.quantity, 0);
  const subtotal = session.lines.reduce(
    (total, line) => total + line.unitPrice * line.quantity,
    0
  );
  const discountAmount = roundToPaise((subtotal * session.discountPercent) / 100);
  const discountedBase = Math.max(0, subtotal - discountAmount);
  const serviceCharge = roundToPaise((discountedBase * session.serviceChargePercent) / 100);
  const taxableValue = discountedBase + serviceCharge;
  const cgst = roundToPaise(taxableValue * POS_CGST_RATE);
  const sgst = roundToPaise(taxableValue * POS_SGST_RATE);
  const payable = taxableValue + cgst + sgst;
  const grandTotal = Math.round(payable);

  return {
    itemCount,
    subtotal: roundToPaise(subtotal),
    discountAmount,
    serviceCharge,
    cgst,
    sgst,
    taxTotal: roundToPaise(cgst + sgst),
    roundOff: roundToPaise(grandTotal - payable),
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
  const tendered = method === "CASH" ? Math.round(amountTendered) : bill.grandTotal;
  if (!Number.isSafeInteger(tendered) || tendered < bill.grandTotal) {
    throw new Error(`Amount tendered must be at least ₹${bill.grandTotal}.`);
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
  let taxCollected = 0;
  let discountsGiven = 0;
  let covers = 0;

  for (const session of settled) {
    const bill = calculatePosBill(session);
    grossSales += bill.grandTotal;
    taxCollected += bill.taxTotal;
    discountsGiven += bill.discountAmount;
    covers += session.guestCount;
    if (session.payment) {
      byPaymentMethod[session.payment.method] += bill.grandTotal;
    }
  }

  return {
    settledBills: settled.length,
    covers,
    grossSales: roundToPaise(grossSales),
    taxCollected: roundToPaise(taxCollected),
    discountsGiven: roundToPaise(discountsGiven),
    averageBill: settled.length ? Math.round(grossSales / settled.length) : 0,
    byPaymentMethod,
  };
}

export function openShift(input: {
  outletId: number;
  openedBy: string;
  openingCash: number;
}): PosShift {
  const outlet = getPosOutlets().find((candidate) => candidate.outletId === input.outletId);
  if (!outlet) {
    throw new Error("Select a valid outlet before opening a shift.");
  }
  const openedBy = input.openedBy.trim();
  if (openedBy.length < 2 || openedBy.length > 40) {
    throw new Error("Enter the name of the cashier opening the shift.");
  }
  const openingCash = Math.round(input.openingCash);
  if (!Number.isSafeInteger(openingCash) || openingCash < 0 || openingCash > 10000000) {
    throw new Error("Opening cash float must be a whole rupee amount.");
  }

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
  const countedCash = Math.round(input.countedCash);
  if (!Number.isSafeInteger(countedCash) || countedCash < 0 || countedCash > 10000000) {
    throw new Error("Counted cash must be a whole rupee amount.");
  }

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
      cashVariance: roundToPaise(countedCash - expectedCash),
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

    return parsed.slice(0, 200).flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const {
        sessionId,
        outletId,
        outletName,
        tableId,
        guestCount,
        serverName,
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
        (status !== "OPEN" && status !== "SETTLED" && status !== "MERGED") ||
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
            note: typeof note === "string" ? note.slice(0, 120) : "",
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
                          note: typeof rawLine.note === "string" ? rawLine.note.slice(0, 120) : "",
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
          revision:
            Number.isSafeInteger(revision) && (revision as number) >= 0
              ? (revision as number)
              : 0,
        },
      ];
    });
  } catch {
    return [];
  }
}
