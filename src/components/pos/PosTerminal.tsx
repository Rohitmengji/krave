"use client";

import React, { useEffect, useEffectEvent, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRightLeft,
  Ban,
  ChefHat,
  CheckCircle2,
  Clock,
  Leaf,
  Lock,
  Merge,
  Minus,
  Pencil,
  Plus,
  Printer,
  Receipt,
  Search,
  Split,
  Trash2,
  Users,
  Wallet,
  X,
} from "lucide-react";
import {
  addCustomItemToSession,
  addItemToSession,
  billFingerprint,
  calculateItemizedSplit,
  calculatePosBill,
  changeSettledPayment,
  closeShift,
  findKitchenTicket,
  getShiftSessions,
  mergeTableSessions,
  openShift,
  openTableSession,
  POS_SEAT_HANDOFF_KEY,
  POS_SHIFT_STORAGE_KEY,
  POS_STORAGE_KEY,
  POS_TABLES,
  releaseTable,
  reopenSettledSession,
  restorePosSessions,
  restorePosShift,
  sendPendingToKitchen,
  setLineNote,
  setLineQuantity,
  setSessionCharges,
  setTableGuest,
  setTableServer,
  settleSession,
  summarizeShift,
  transferTableSession,
  voidLine,
  type PosCatalog,
  type PosKitchenTicket,
  type PosOutlet,
  type PosPaymentMethod,
  type PosShift,
  type PosTableSession,
  type PosZReport,
} from "@/lib/pos/posEngine";
import type { DietaryType } from "@/types/krave";
import { AVAILABILITY_KEY, restoreAvailability } from "@/lib/checkout";
import { billSmsText } from "@/lib/pos/billSms";
import { UNNAMED_ACCOUNT, usePosFloorSync } from "./usePosFloorSync";
import { displayMobile, GuestContactEditor, PosGuestCard } from "./PosGuestCard";
import { SendBill } from "./SendBill";
import { BillEmailAndPdf, SendToNumber, useBillLink } from "./PosBillShare";
import { PosReceiptPaper } from "./PosReceiptPaper";
import { PosSalesHistory } from "./PosSalesHistory";
import { DietaryMark, PosMenuGrid } from "./PosMenuGrid";
import { PosOwnerApproval, type OwnerCorrection } from "./PosOwnerApproval";
import { OverlayDialog } from "../OverlayDialog";
import { POS_CLOSE_BUTTON, POS_FORM_DIALOG, POS_PAPER_DIALOG } from "./posDialog";

const ZONES = [...new Set(POS_TABLES.map((table) => table.zone))];

/** A reservation handed over from the storefront, consumed once then cleared. */
interface SeatHandoff {
  resId: number;
  bookingId: string;
  guestName: string;
  guests: number;
  timeSlot: string;
}

function readSeatHandoff(): SeatHandoff | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(POS_SEAT_HANDOFF_KEY) || "null");
    if (!raw || typeof raw !== "object") return null;
    const value = raw as Record<string, unknown>;
    if (
      typeof value.resId !== "number" ||
      typeof value.bookingId !== "string" ||
      !value.bookingId.startsWith("TBL-") ||
      typeof value.guestName !== "string" ||
      !Number.isSafeInteger(value.guests)
    ) {
      return null;
    }
    return {
      resId: value.resId,
      bookingId: value.bookingId,
      guestName: value.guestName.slice(0, 80),
      guests: Math.min(Math.max(value.guests as number, 1), 50),
      timeSlot: typeof value.timeSlot === "string" ? value.timeSlot.slice(0, 40) : "",
    };
  } catch {
    return null;
  }
}

function formatMoney(value: number): string {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatElapsed(openedAt: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(openedAt)) / 60000));
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function PosTerminal({ catalog, mailEnabled }: { catalog: PosCatalog; mailEnabled: boolean }) {
  if (catalog.status === "ready" && catalog.outlets.length > 0) {
    return <PosFloor outlets={catalog.outlets} mailEnabled={mailEnabled} />;
  }
  const message =
    catalog.status === "signed-out"
      ? {
          title: "Sign in to take table orders",
          body: "The terminal bills from your restaurant's own menu, so it needs the account that runs the restaurant.",
          href: "/signin",
          action: "Sign in",
        }
      : catalog.status === "unavailable"
      ? {
          title: "Your menu could not be loaded",
          body: "Check the connection and try again. Nothing has been lost.",
          href: "/pos",
          action: "Try again",
        }
      : {
          title: "No restaurant on this account yet",
          body: "Ask the restaurant's owner to add this account's email under Team in their owner workspace. Then reload this page.",
          href: "/owner",
          action: "Open owner workspace",
        };
  return (
    <main className="min-h-screen bg-[#0A0D12] px-4 py-10 text-white">
      <div className="mx-auto max-w-lg space-y-5">
        <Link
          href="/"
          className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5"
        >
          <ArrowLeft className="h-4 w-4" />
          Storefront
        </Link>
        <section
          data-testid="pos-unavailable"
          className="space-y-3 rounded-3xl border border-white/10 bg-[#121721] p-6"
        >
          <h1 className="text-xl font-black">{message.title}</h1>
          <p className="text-sm text-white/75">{message.body}</p>
          <Link
            href={message.href}
            className="inline-flex min-h-11 items-center rounded-xl bg-emerald-700 px-4 text-sm font-black text-white hover:bg-emerald-800"
          >
            {message.action}
          </Link>
        </section>
      </div>
    </main>
  );
}

function PosFloor({ outlets, mailEnabled }: { outlets: PosOutlet[]; mailEnabled: boolean }) {
  const [outletId, setOutletId] = useState(outlets[0].outletId);
  const [sessions, setSessions] = useState<PosTableSession[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);

  const [activeTableId, setActiveTableId] = useState<string | null>(null);
  const [menuQuery, setMenuQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const [openTableForm, setOpenTableForm] = useState<{ tableId: string } | null>(null);
  const [guestCount, setGuestCount] = useState(2);
  const [serverName, setServerName] = useState("Front Desk");
  const [leadGuestName, setLeadGuestName] = useState("");
  const [leadGuestPhone, setLeadGuestPhone] = useState("");

  const [voidTarget, setVoidTarget] = useState<{ lineId: string; name: string } | null>(null);
  const [voidReason, setVoidReason] = useState("");

  const [settleOpen, setSettleOpen] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PosPaymentMethod>("CASH");
  const [tendered, setTendered] = useState("");

  const [receiptSessionId, setReceiptSessionId] = useState<string | null>(null);
  const [kitchenTicket, setKitchenTicket] = useState<PosKitchenTicket | null>(null);
  const [isReprint, setIsReprint] = useState(false);

  // Cash-up state: one shift may be open per terminal at a time.
  const [activeShift, setActiveShift] = useState<PosShift | null>(null);
  const [shiftFormOpen, setShiftFormOpen] = useState(false);
  const [openingCash, setOpeningCash] = useState("2000");
  const [cashierName, setCashierName] = useState("Front Desk");
  const [countedCash, setCountedCash] = useState("");
  const [zReport, setZReport] = useState<PosZReport | null>(null);

  const [seatHandoff, setSeatHandoff] = useState<SeatHandoff | null>(null);
  const [unavailableItemIds, setUnavailableItemIds] = useState<string[]>([]);

  const [claimCodes, setClaimCodes] = useState<Record<string, string>>({});
  const [billNumbers, setBillNumbers] = useState<Record<string, number>>({});
  // localStorage stays the working copy; the server is the durable one when signed in.
  const { syncAccount, syncState, syncMessage } = usePosFloorSync({
    hydrated,
    outlets,
    sessions,
    setSessions,
    activeShift,
    setActiveShift,
    setBillNumbers,
    setClaimCodes,
    setUnavailableItemIds,
    announce,
  });
  // A waiter on their own phone serves and cashes up under their own name, not "Front Desk".
  const [namedAfter, setNamedAfter] = useState<string | null>(null);
  if (syncAccount && syncAccount !== UNNAMED_ACCOUNT && syncAccount !== namedAfter) {
    setNamedAfter(syncAccount);
    if (serverName === "Front Desk") setServerName(syncAccount);
    if (cashierName === "Front Desk") setCashierName(syncAccount);
  }
  /** `sessionId:seat` of the guest whose name and mobile are being corrected. */
  const [editingGuest, setEditingGuest] = useState<string | null>(null);
  const [editingServerFor, setEditingServerFor] = useState<string | null>(null);
  const [serverDraft, setServerDraft] = useState("");
  const [ownerAction, setOwnerAction] = useState<{
    kind: "payment" | "reopen";
    sessionId: string;
  } | null>(null);

  // Custom off-menu dish form state
  const [customDishOpen, setCustomDishOpen] = useState(false);
  const [customDishName, setCustomDishName] = useState("");
  const [customDishPrice, setCustomDishPrice] = useState("");
  const [customDishQty, setCustomDishQty] = useState(1);
  const [customDishDietary, setCustomDishDietary] = useState<DietaryType>("veg");
  const [customDishNote, setCustomDishNote] = useState("");

  // Interactive guest bill splitter state
  const [splitModalOpen, setSplitModalOpen] = useState(false);
  const [lineAssignments, setLineAssignments] = useState<Record<string, number>>({});

  // Settled bills history drawer state
  const [salesOpen, setSalesOpen] = useState(false);

  const isKnownOutlet = useEffectEvent((id: number) =>
    outlets.some((outlet) => outlet.outletId === id)
  );

  useEffect(() => {
    try {
      // Tables at an outlet this account cannot bill for (one from the retired sample catalog,
      // or a restaurant it was removed from) would only ever be refused by the server.
      setSessions(
        restorePosSessions(localStorage.getItem(POS_STORAGE_KEY)).filter((session) =>
          isKnownOutlet(session.outletId)
        )
      );
      const restoredShift = restorePosShift(localStorage.getItem(POS_SHIFT_STORAGE_KEY));
      if (restoredShift && isKnownOutlet(restoredShift.outletId)) {
        setActiveShift(restoredShift);
        setOutletId(restoredShift.outletId);
      }
      setUnavailableItemIds(restoreAvailability(localStorage.getItem(AVAILABILITY_KEY)));

      const handoff = readSeatHandoff();
      if (handoff) {
        // A booking is seated once; clearing immediately stops a refresh from re-opening it.
        localStorage.removeItem(POS_SEAT_HANDOFF_KEY);
        if (isKnownOutlet(handoff.resId)) {
          setSeatHandoff(handoff);
          setOutletId(handoff.resId);
          setGuestCount(handoff.guests);
          setLeadGuestName(handoff.guestName);
        }
      }
    } catch {
      setStorageWarning("Browser storage is unavailable. Tables will reset when you close this tab.");
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(POS_STORAGE_KEY, JSON.stringify(sessions));
      if (activeShift) {
        localStorage.setItem(POS_SHIFT_STORAGE_KEY, JSON.stringify(activeShift));
      } else {
        localStorage.removeItem(POS_SHIFT_STORAGE_KEY);
      }
    } catch {
      setStorageWarning("Could not save tables on this device.");
    }
  }, [sessions, activeShift, hydrated]);

  // Table timers only need minute precision, so a 30s tick keeps them accurate without churn.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  const currentOutlet = outlets.find((outlet) => outlet.outletId === outletId) ?? outlets[0];
  const menu = currentOutlet.menu;
  const seesAllSales = currentOutlet.seesAllSales;
  const categories = useMemo(
    () => [...new Set(menu.map((item) => item.categoryName))],
    [menu]
  );

  const visibleMenu = useMemo(() => {
    const query = menuQuery.trim().toLowerCase();
    return menu.filter((item) => {
      if (unavailableItemIds.includes(item.itemId)) return false;
      if (categoryFilter && item.categoryName !== categoryFilter) return false;
      if (query && !query.split(/\s+/).every((word) => item.name.toLowerCase().includes(word))) {
        return false;
      }
      return true;
    });
  }, [menu, menuQuery, categoryFilter, unavailableItemIds]);

  const openSessions = useMemo(
    () => sessions.filter((session) => session.status === "OPEN" && session.outletId === outletId),
    [sessions, outletId]
  );

  const activeSession = useMemo(
    () => openSessions.find((session) => session.tableId === activeTableId) ?? null,
    [openSessions, activeTableId]
  );

  const bill = useMemo(
    () => (activeSession ? calculatePosBill(activeSession) : null),
    [activeSession]
  );

  const freeTables = useMemo(
    () =>
      POS_TABLES.filter(
        (table) => !openSessions.some((session) => session.tableId === table.tableId)
      ),
    [openSessions]
  );

  const guestSplitShares = useMemo(
    () => (activeSession ? calculateItemizedSplit(activeSession, lineAssignments) : []),
    [activeSession, lineAssignments]
  );

  const receiptSession = useMemo(
    () => sessions.find((session) => session.sessionId === receiptSessionId) ?? null,
    [sessions, receiptSessionId]
  );

  const receiptBill = useMemo(
    () => (receiptSession ? calculatePosBill(receiptSession) : null),
    [receiptSession]
  );

  // The bill's own restaurant, which need not be the outlet picked in the header.
  const receiptOutlet = receiptSession
    ? outlets.find((outlet) => outlet.outletId === receiptSession.outletId)
    : undefined;

  const receiptSmsGuests = (receiptSession?.guests ?? []).flatMap((guest) =>
    guest.phone && receiptSession && guest.seat <= receiptSession.guestCount
      ? [{ seat: guest.seat, name: guest.name, phone: guest.phone }]
      : []
  );

  // The header counts today on this phone; Sales shows every terminal's bills from the server.
  const today = useMemo(() => {
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    return summarizeShift(
      sessions.filter(
        (session) =>
          session.outletId === outletId &&
          Date.parse(session.payment?.settledAt ?? "") >= midnight.getTime()
      )
    );
  }, [sessions, outletId, now]);

  /** Tables the active bill can absorb: same outlet, still open, and not this table. */
  const mergeCandidates = useMemo(
    () =>
      activeSession
        ? openSessions.filter(
            (session) =>
              session.sessionId !== activeSession.sessionId && session.lines.length > 0
          )
        : [],
    [openSessions, activeSession]
  );

  const pendingCount =
    activeSession?.lines.filter((line) => line.kotNumber === null).length ?? 0;

  const activeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const line of activeSession?.lines ?? []) {
      counts.set(line.itemId, (counts.get(line.itemId) ?? 0) + line.quantity);
    }
    return counts;
  }, [activeSession]);

  /** A filter changes what is listed; if the list starts above the screen, bring its top back. */
  function revealMenuTop() {
    const heading = document.getElementById("menu-heading");
    if (heading && heading.getBoundingClientRect().top < 0) heading.scrollIntoView({ block: "start" });
  }

  /** On a phone the floor, menu and bill stack, so jump to where the next tap happens. */
  function scrollToOnPhone(elementId: string) {
    if (window.matchMedia("(min-width: 1024px)").matches) return;
    document.getElementById(elementId)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const seatedGuests =
    activeSession?.guests.filter((guest) => guest.seat <= activeSession.guestCount) ?? [];
  const leadGuest = seatedGuests.find((guest) => guest.seat === 1);
  // The whole bill goes to whoever is paying; the lead guest first, else anyone with a number.
  const smsGuest = seatedGuests.find((guest) => guest.phone) ?? null;
  const signedIn = syncAccount !== null;
  // The guest's link is given only for the bill on screen, once this phone's saves have landed.
  const savedHere = syncState === "synced";
  const receiptFingerprint = receiptSession ? billFingerprint(receiptSession) : null;
  const receiptLink = useBillLink(receiptSessionId, signedIn, receiptFingerprint, savedHere);
  const tableLink = useBillLink(
    smsGuest?.phone && activeSession && activeSession.lines.length > 0 ? activeSession.sessionId : null,
    signedIn,
    activeSession ? billFingerprint(activeSession) : null,
    savedHere
  );

  function run(action: () => void) {
    try {
      setError(null);
      action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    }
  }

  /**
   * Applies a change to the table as it stands when React runs the update, not to the copy
   * this render captured: a floor poll may have taken another phone's save in between, and
   * rewriting the captured copy would quietly undo it. The engine call is pure, so running it
   * once to check it is allowed and once to apply it is safe.
   */
  function changeSession(
    sessionId: string,
    change: (session: PosTableSession) => PosTableSession
  ) {
    setSessions((previous) =>
      previous.map((session) => {
        if (session.sessionId !== sessionId) return session;
        try {
          return change(session);
        } catch {
          // The newest copy will not take this change (it was settled or moved elsewhere).
          return session;
        }
      })
    );
  }

  function updateActiveSession(update: (session: PosTableSession) => PosTableSession) {
    if (!activeSession) {
      setError("Open a table before adding items.");
      return;
    }
    run(() => {
      // Checked against the table on screen, so the waiter sees why a change is refused.
      update(activeSession);
      changeSession(activeSession.sessionId, update);
    });
  }

  function announce(message: string) {
    setNotice(message);
    setTimeout(() => setNotice((current) => (current === message ? null : current)), 2600);
  }

  function saveGuest(
    sessionId: string,
    seat: number,
    input: { name: string; phone: string }
  ): string | null {
    const session = sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session) return "This table is no longer on the floor.";
    try {
      setTableGuest(session, seat, input);
      changeSession(sessionId, (current) => setTableGuest(current, seat, input));
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught.message : "Could not save this guest.";
    }
  }

  /** Applied only after the owner's PIN has been accepted by the server. */
  function applyOwnerCorrection(sessionId: string, correction: OwnerCorrection): string | null {
    const session = sessions.find((candidate) => candidate.sessionId === sessionId);
    if (!session) return "This bill is no longer on this terminal.";
    const openShiftId = activeShift?.shiftId ?? null;
    try {
      const next =
        correction.kind === "payment"
          ? changeSettledPayment(session, correction.method, correction.reason, openShiftId)
          : reopenSettledSession(session, correction.reason, openShiftId, sessions);
      setSessions((previous) =>
        previous.map((candidate) => (candidate.sessionId === sessionId ? next : candidate))
      );
      if (correction.kind === "reopen") {
        setReceiptSessionId(null);
        setOutletId(next.outletId);
        setActiveTableId(next.tableId);
        announce(`${next.tableId} reopened. Add items, then settle again.`);
      } else {
        announce(`Table ${next.tableId} bill now marked as paid by ${correction.method}.`);
      }
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught.message : "Could not change this bill.";
    }
  }

  function handleOpenTable(event: React.FormEvent) {
    event.preventDefault();
    if (!openTableForm) return;
    run(() => {
      const session = openTableSession({
        outletId,
        outletName: currentOutlet.name,
        tableId: openTableForm.tableId,
        guestCount,
        serverName,
        taxRateBps: currentOutlet.taxRateBps,
        leadGuest: { name: leadGuestName, phone: leadGuestPhone },
        shiftId: activeShift?.shiftId ?? null,
      });
      setSessions((previous) => [...previous, session]);
      setActiveTableId(session.tableId);
      setOpenTableForm(null);
      scrollToOnPhone("menu-heading");
      const booking = seatHandoff ? ` · Booking ${seatHandoff.bookingId}` : "";
      setSeatHandoff(null);
      announce(`${session.tableId} opened for ${session.guestCount} guests.${booking}`);
    });
  }

  function handleSendToKitchen() {
    if (!activeSession) return;
    run(() => {
      const { session, ticket } = sendPendingToKitchen(activeSession);
      setSessions((previous) =>
        previous.map((candidate) =>
          candidate.sessionId === session.sessionId ? session : candidate
        )
      );
      setIsReprint(false);
      setKitchenTicket(ticket);
    });
  }

  function handleReprintTicket(kotNumber: number) {
    if (!activeSession) return;
    run(() => {
      setIsReprint(true);
      setKitchenTicket(findKitchenTicket(activeSession, kotNumber));
    });
  }

  function handleMergeTable(sourceSessionId: string) {
    if (!activeSession || !sourceSessionId) return;
    run(() => {
      const source = sessions.find((session) => session.sessionId === sourceSessionId);
      const updated = mergeTableSessions(sessions, sourceSessionId, activeSession.sessionId);
      setSessions(updated);
      announce(`Merged ${source?.tableId ?? "table"} into ${activeSession.tableId}.`);
    });
  }

  function handleOpenShift(event: React.FormEvent) {
    event.preventDefault();
    run(() => {
      const opened = openShift({
        outletId,
        outletName: currentOutlet.name,
        openedBy: cashierName,
        openingCash: Number(openingCash || 0),
      });
      setActiveShift(opened);
      setShiftFormOpen(false);
      announce(`Shift opened with a \u20b9${opened.openingCash} float.`);
    });
  }

  function handleCloseShift(event: React.FormEvent) {
    event.preventDefault();
    if (!activeShift) return;
    run(() => {
      const { report } = closeShift(activeShift, sessions, {
        closedBy: cashierName,
        countedCash: Number(countedCash || 0),
      });
      setActiveShift(null);
      setShiftFormOpen(false);
      setCountedCash("");
      setZReport(report);
    });
  }

  function handleVoid(event: React.FormEvent) {
    event.preventDefault();
    if (!voidTarget) return;
    updateActiveSession((session) => voidLine(session, voidTarget.lineId, voidReason));
    setVoidTarget(null);
    setVoidReason("");
  }

  function handleAddCustomDish(event: React.FormEvent) {
    event.preventDefault();
    updateActiveSession((session) =>
      addCustomItemToSession(session, {
        name: customDishName,
        price: Number(customDishPrice),
        dietary: customDishDietary,
        quantity: customDishQty,
        note: customDishNote,
      })
    );
    setCustomDishName("");
    setCustomDishPrice("");
    setCustomDishQty(1);
    setCustomDishNote("");
    setCustomDishOpen(false);
    announce("Added custom dish to table bill.");
  }

  function handleTransferTable(targetTableId: string) {
    if (!activeSession || !targetTableId) return;
    run(() => {
      const updated = transferTableSession(sessions, activeSession.sessionId, targetTableId);
      setSessions(updated);
      setActiveTableId(targetTableId);
      announce(`Moved bill from ${activeSession.tableId} to ${targetTableId}.`);
    });
  }

  function handleSettle(event: React.FormEvent) {
    event.preventDefault();
    if (!activeSession) return;
    run(() => {
      const settled = settleSession(
        activeSession,
        paymentMethod,
        paymentMethod === "CASH" ? Number(tendered || 0) : 0
      );
      setSessions((previous) =>
        previous.map((session) =>
          session.sessionId === settled.sessionId ? settled : session
        )
      );
      setSettleOpen(false);
      setTendered("");
      setActiveTableId(null);
      setReceiptSessionId(settled.sessionId);
    });
  }

  return (
    <div className="min-h-screen bg-[#0A0D12] text-white">
      {/* Pinned only where it fits on one row; on a phone it wraps to a third of the screen. */}
      <header className="pos-no-print z-30 border-b border-white/10 bg-[#0A0D12]/95 backdrop-blur xl:sticky xl:top-0">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-3 px-4 py-3">
          <Link
            href="/"
            className="flex min-h-11 items-center gap-1.5 rounded-xl border border-white/10 px-3 text-xs font-bold hover:bg-white/5"
          >
            <ArrowLeft className="h-4 w-4" />
            Storefront
          </Link>

          <div>
            <h1 className="text-lg font-black leading-tight">Dine-In Billing Terminal</h1>
            <p className="text-[11px] opacity-60" data-testid="pos-sync-status">
              {syncAccount
                ? syncState === "synced"
                  ? `Live with the team · Saved to ${syncAccount}`
                  : syncState === "failed"
                  ? "Works offline · Saved on this device, waiting to sync"
                  : "Works offline · Syncing..."
                : "Works offline · Saved on this device"}
            </p>
          </div>

          <label className="ml-auto flex items-center gap-2 text-xs">
            <span className="opacity-60">Outlet</span>
            <select
              value={outletId}
              onChange={(event) => {
                setOutletId(Number(event.target.value));
                setActiveTableId(null);
                setCategoryFilter(null);
              }}
              className="min-h-11 rounded-xl border border-white/15 bg-[#121721] px-3 text-base font-bold sm:text-xs"
            >
              {outlets.map((outlet) => (
                <option key={outlet.outletId} value={outlet.outletId}>
                  {outlet.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-wrap gap-2 text-[11px]">
            <span className="flex min-h-11 items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3">
              Open tables <strong className="text-emerald-400">{openSessions.length}</strong>
            </span>
            {seesAllSales ? (
              <>
                <button
                  type="button"
                  data-testid="pos-open-settled-history"
                  onClick={() => setSalesOpen(true)}
                  className="min-h-11 rounded-lg border border-white/15 bg-white/5 px-3 hover:border-emerald-400/50 transition"
                >
                  Bills today <strong className="text-emerald-400">{today.settledBills}</strong>
                </button>
                <button
                  type="button"
                  data-testid="pos-open-sales"
                  onClick={() => setSalesOpen(true)}
                  className="flex min-h-11 items-center gap-1 rounded-lg border border-emerald-400/40 bg-emerald-500/10 px-3 font-bold hover:bg-emerald-500/20 transition"
                >
                  Sales today <strong className="text-emerald-300">₹{formatMoney(today.grossSales)}</strong>
                  <span aria-hidden="true">›</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                data-testid="pos-open-sales"
                onClick={() => setSalesOpen(true)}
                className="flex min-h-11 items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-3 font-bold hover:border-emerald-400/50 transition"
              >
                <Search className="h-3.5 w-3.5" aria-hidden="true" />
                Find a bill
              </button>
            )}
            <span className="flex min-h-11 items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-3">
              Covers <strong className="text-emerald-400">{today.covers}</strong>
            </span>
            <button
              type="button"
              data-testid="pos-shift-control"
              onClick={() => {
                setError(null);
                setCountedCash(
                  activeShift
                    ? String(
                        activeShift.openingCash +
                          summarizeShift(getShiftSessions(activeShift, sessions)).byPaymentMethod
                            .CASH
                      )
                    : ""
                );
                setShiftFormOpen(true);
              }}
              className={`min-h-11 rounded-lg border px-3 font-bold transition ${
                activeShift
                  ? "border-emerald-400/50 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                  : "border-white/15 bg-white/5 hover:border-emerald-400/50"
              }`}
            >
              {activeShift ? "Close Shift" : "Open Shift"}
            </button>
          </div>
        </div>
      </header>

      {storageWarning && (
        <p role="status" className="pos-no-print px-4 py-2 text-xs text-amber-400">
          {storageWarning}
        </p>
      )}

      {syncMessage && (
        <p role="status" className="pos-no-print px-4 py-2 text-xs text-amber-400">
          {syncMessage}
        </p>
      )}

      {seatHandoff && (
        <p
          role="status"
          data-testid="pos-seat-handoff"
          className="pos-no-print mx-auto max-w-[1600px] px-4 pt-3 text-xs text-emerald-300"
        >
          Seating booking {seatHandoff.bookingId} — {seatHandoff.guestName}, {seatHandoff.guests}{" "}
          guests{seatHandoff.timeSlot ? ` at ${seatHandoff.timeSlot}` : ""}. Pick a free table to
          open the bill.
        </p>
      )}

      <main className="pos-no-print mx-auto grid max-w-[1600px] grid-cols-[minmax(0,1fr)] gap-4 p-4 pb-28 lg:grid-cols-[260px_minmax(0,1fr)_380px] lg:pb-4">
        {/* Floor plan */}
        <section aria-labelledby="floor-heading" className="h-fit space-y-4 lg:sticky lg:top-4 xl:top-20">
          <h2 id="floor-heading" className="text-xs font-bold uppercase tracking-wider opacity-60">
            Floor Plan
          </h2>

          {ZONES.map((zone) => (
            <div key={zone} className="space-y-2">
              <h3 className="text-[11px] font-bold opacity-50">{zone}</h3>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-3">
                {POS_TABLES.filter((table) => table.zone === zone).map((table) => {
                  const session = openSessions.find(
                    (candidate) => candidate.tableId === table.tableId
                  );
                  const isActive = activeTableId === table.tableId;
                  const runningTotal = session ? calculatePosBill(session).grandTotal : 0;

                  return (
                    <button
                      key={table.tableId}
                      type="button"
                      data-testid={`pos-table-${table.tableId}`}
                      onClick={() => {
                        setError(null);
                        if (session) {
                          setActiveTableId(table.tableId);
                          scrollToOnPhone("menu-heading");
                        } else {
                          // A booking being seated already states its party size; don't overwrite it.
                          if (!seatHandoff) {
                            setGuestCount(Math.min(table.seats, 4));
                            setLeadGuestName("");
                          }
                          setLeadGuestPhone("");
                          setOpenTableForm({ tableId: table.tableId });
                        }
                      }}
                      className={`rounded-2xl border p-2 text-left transition ${
                        isActive
                          ? "border-emerald-400 bg-emerald-500/20"
                          : session
                          ? "border-amber-400/50 bg-amber-500/10 hover:border-amber-400"
                          : "border-white/10 bg-[#121721] hover:border-white/30"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-black">{table.label}</span>
                        <span className="flex items-center gap-0.5 text-[10px] opacity-60">
                          <Users className="h-3 w-3" />
                          {session ? session.guestCount : table.seats}
                        </span>
                      </div>
                      {session ? (
                        <div className="mt-1 space-y-0.5">
                          <div className="text-[11px] font-bold text-emerald-300">
                            ₹{runningTotal}
                          </div>
                          {session.guests[0]?.name && (
                            <div className="truncate text-[10px] opacity-75">
                              {session.guests[0].name}
                            </div>
                          )}
                          <div className="flex items-center gap-1 text-[10px] opacity-60">
                            <Clock className="h-3 w-3" />
                            {formatElapsed(session.openedAt, now)}
                          </div>
                        </div>
                      ) : (
                        <div className="mt-1 text-[10px] opacity-50">Free</div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </section>

        {/* Menu */}
        <section aria-labelledby="menu-heading" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="menu-heading" className="scroll-mt-4 text-xs font-bold uppercase tracking-wider opacity-60 xl:scroll-mt-20">
              {activeSession ? `Menu — adding to ${activeSession.tableId}` : "Menu — pick a table first"}
              {unavailableItemIds.length > 0 && (
                <span className="ml-2 font-normal normal-case text-rose-400">
                  {unavailableItemIds.length} dish{unavailableItemIds.length === 1 ? "" : "es"} marked 86
                </span>
              )}
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="pos-toggle-custom-dish"
                onClick={() => setCustomDishOpen((prev) => !prev)}
                className="flex min-h-11 items-center gap-1 rounded-xl border border-emerald-400/40 bg-emerald-500/15 px-3 text-xs font-bold text-emerald-300 hover:bg-emerald-500/25"
              >
                <Plus className="h-3.5 w-3.5" />
                Custom / Off-Menu Dish
              </button>
            </div>
          </div>

          {customDishOpen && (
            <form
              onSubmit={handleAddCustomDish}
              data-testid="pos-custom-dish-form"
              className="grid grid-cols-1 gap-2 rounded-2xl border border-emerald-400/30 bg-[#121721] p-3 sm:grid-cols-6"
            >
              <input
                type="text"
                required
                aria-label="Dish or drink name"
                value={customDishName}
                onChange={(event) => setCustomDishName(event.target.value)}
                placeholder="Custom dish / drink name"
                className="min-h-11 rounded-xl border border-white/15 bg-[#0E131D] px-3 text-base sm:col-span-2 sm:text-xs"
              />
              <input
                type="number"
                inputMode="decimal"
                required
                min={1}
                max={100000}
                aria-label="Price in rupees"
                value={customDishPrice}
                onChange={(event) => setCustomDishPrice(event.target.value)}
                placeholder="Price (₹)"
                className="min-h-11 rounded-xl border border-white/15 bg-[#0E131D] px-3 text-base sm:text-xs"
              />
              <select
                value={customDishDietary}
                onChange={(event) => setCustomDishDietary(event.target.value as DietaryType)}
                aria-label="Dietary type"
                className="min-h-11 rounded-xl border border-white/15 bg-[#0E131D] px-2.5 text-base font-bold sm:text-xs"
              >
                <option value="veg">Veg</option>
                <option value="non-veg">Non-Veg</option>
                <option value="egg">Egg</option>
              </select>
              <input
                type="text"
                aria-label="Cooking note (optional)"
                value={customDishNote}
                onChange={(event) => setCustomDishNote(event.target.value)}
                placeholder="Cooking note (optional)"
                className="min-h-11 rounded-xl border border-white/15 bg-[#0E131D] px-3 text-base sm:text-xs"
              />
              <button
                type="submit"
                data-testid="pos-submit-custom-dish"
                className="min-h-11 rounded-xl bg-emerald-500 px-3 text-sm font-black text-black"
              >
                Add to Table
              </button>
            </form>
          )}

          <div className="sticky top-0 z-20 -mx-4 space-y-2 bg-[#0A0D12]/95 px-4 py-2 backdrop-blur lg:mx-0 lg:px-0 xl:top-16">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
              <input
                type="search"
                aria-label="Search menu"
                value={menuQuery}
                onChange={(event) => {
                  setMenuQuery(event.target.value);
                  revealMenuTop();
                }}
                placeholder="Search dishes, e.g. mutton fry"
                className="min-h-11 w-full rounded-xl border border-white/15 bg-[#121721] py-2 pl-9 pr-3 text-base outline-none focus:border-emerald-400/60 sm:text-sm"
              />
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
              <button
                type="button"
                onClick={() => {
                  setCategoryFilter(null);
                  revealMenuTop();
                }}
                className={`min-h-11 shrink-0 whitespace-nowrap rounded-xl border px-3.5 text-xs font-bold ${
                  categoryFilter === null
                    ? "border-emerald-400 bg-emerald-500/20 text-emerald-300"
                    : "border-white/10 bg-[#121721]"
                }`}
              >
                All
              </button>
              {categories.map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => {
                    setCategoryFilter(category);
                    revealMenuTop();
                  }}
                  className={`min-h-11 shrink-0 whitespace-nowrap rounded-xl border px-3.5 text-xs font-bold ${
                    categoryFilter === category
                      ? "border-emerald-400 bg-emerald-500/20 text-emerald-300"
                      : "border-white/10 bg-[#121721]"
                  }`}
                >
                  {category}
                </button>
              ))}
            </div>
          </div>

          <PosMenuGrid
            items={visibleMenu}
            grouped={categoryFilter === null && !menuQuery.trim()}
            countOf={(itemId) => activeCounts.get(itemId) ?? 0}
            onAdd={(item) => updateActiveSession((session) => addItemToSession(session, item))}
          />
        </section>

        {/* Running bill */}
        <section
          aria-labelledby="bill-heading"
          className="h-fit space-y-3 rounded-2xl border border-white/10 bg-[#121721] p-4 lg:sticky lg:top-24"
        >
          <div className="flex items-center justify-between">
            <h2 id="bill-heading" className="text-sm font-black">
              {activeSession ? `Table ${activeSession.tableId}` : "No table selected"}
            </h2>
            {activeSession &&
              (editingServerFor === activeSession.sessionId ? (
                <form
                  className="flex items-center gap-1"
                  onSubmit={(event) => {
                    event.preventDefault();
                    updateActiveSession((session) => setTableServer(session, serverDraft));
                    if (serverDraft.trim().length >= 2) setEditingServerFor(null);
                  }}
                >
                  <input
                    aria-label="Waiter name"
                    data-testid="pos-server-input"
                    value={serverDraft}
                    maxLength={40}
                    onChange={(event) => setServerDraft(event.target.value)}
                    className="min-h-11 w-32 rounded-lg border border-white/15 bg-[#0E131D] px-2 text-base sm:text-xs"
                  />
                  <button
                    type="submit"
                    data-testid="pos-server-save"
                    className="min-h-11 rounded-lg bg-emerald-500 px-3 text-xs font-black text-black"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    aria-label="Cancel"
                    onClick={() => setEditingServerFor(null)}
                    className={POS_CLOSE_BUTTON}
                  >
                    <X className="h-4 w-4" />
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  data-testid="pos-edit-server"
                  aria-label={`Waiter: ${activeSession.serverName}. Change`}
                  onClick={() => {
                    setServerDraft(activeSession.serverName);
                    setEditingServerFor(activeSession.sessionId);
                  }}
                  className="flex min-h-11 items-center gap-1 rounded-lg px-2 text-[11px] opacity-70 hover:bg-white/5 hover:opacity-100"
                >
                  {activeSession.serverName}
                  <Pencil className="h-3 w-3" aria-hidden="true" />
                </button>
              ))}
          </div>
          {activeSession &&
            (editingGuest === `${activeSession.sessionId}:1` ? (
              <GuestContactEditor
                seat={1}
                guest={leadGuest}
                tone="dark"
                onSave={(input) => saveGuest(activeSession.sessionId, 1, input)}
                onDone={() => setEditingGuest(null)}
              />
            ) : leadGuest ? (
              <div className="flex items-center justify-between gap-2">
                <p data-testid="pos-lead-guest" className="min-w-0 truncate text-xs opacity-80">
                  Guest: {leadGuest.name || "Unnamed"}
                  {leadGuest.phone ? ` · ${displayMobile(leadGuest.phone)}` : ""}
                </p>
                <button
                  type="button"
                  data-testid="pos-edit-lead-guest"
                  onClick={() => setEditingGuest(`${activeSession.sessionId}:1`)}
                  className="flex min-h-11 shrink-0 items-center gap-1 rounded-lg px-2.5 text-xs font-bold text-sky-300 hover:bg-white/5"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  Edit
                </button>
              </div>
            ) : (
              <button
                type="button"
                data-testid="pos-add-lead-guest"
                onClick={() => setEditingGuest(`${activeSession.sessionId}:1`)}
                className="flex min-h-11 w-full items-center gap-1.5 rounded-lg border border-dashed border-white/15 px-3 text-xs font-bold text-sky-300 hover:bg-white/5"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                Add guest name & mobile
              </button>
            ))}

          {error && (
            <p role="alert" className="rounded-xl bg-rose-500/15 px-3 py-2 text-xs text-rose-300">
              {error}
            </p>
          )}
          {notice && (
            <p role="status" className="rounded-xl bg-emerald-500/15 px-3 py-2 text-xs text-emerald-300">
              {notice}
            </p>
          )}

          {!activeSession || !bill ? (
            <p className="text-xs opacity-60">
              Select a free table to seat guests, or an occupied table to continue its bill.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                <div className="flex items-center gap-2">
                  <label className="flex items-center gap-1.5">
                    <Users className="h-3.5 w-3.5 opacity-60" />
                    <span className="sr-only">Guests</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={50}
                      value={activeSession.guestCount}
                      onChange={(event) =>
                        updateActiveSession((session) =>
                          setSessionCharges(session, { guestCount: Number(event.target.value) })
                        )
                      }
                      className="min-h-11 w-16 rounded-lg border border-white/15 bg-[#0E131D] px-2 text-base sm:text-xs"
                    />
                  </label>
                  <span className="flex items-center gap-1 opacity-60">
                    <Clock className="h-3.5 w-3.5" />
                    {formatElapsed(activeSession.openedAt, now)}
                  </span>
                </div>

                {freeTables.length > 0 && (
                  <label className="flex items-center gap-1 text-xs">
                    <ArrowRightLeft className="h-3.5 w-3.5 opacity-60" />
                    <select
                      aria-label="Move table"
                      value=""
                      onChange={(event) => handleTransferTable(event.target.value)}
                      className="min-h-11 rounded-lg border border-white/15 bg-[#0E131D] px-2.5 text-base font-bold sm:text-xs"
                    >
                      <option value="">Move table...</option>
                      {freeTables.map((table) => (
                        <option key={table.tableId} value={table.tableId}>
                          Move to {table.label} ({table.zone})
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {mergeCandidates.length > 0 && (
                  <label className="flex items-center gap-1 text-xs">
                    <Merge className="h-3.5 w-3.5 opacity-60" />
                    <select
                      aria-label="Merge another table into this bill"
                      data-testid="pos-merge-select"
                      value=""
                      onChange={(event) => handleMergeTable(event.target.value)}
                      className="min-h-11 rounded-lg border border-white/15 bg-[#0E131D] px-2.5 text-base font-bold sm:text-xs"
                    >
                      <option value="">Merge table...</option>
                      {mergeCandidates.map((session) => (
                        <option key={session.sessionId} value={session.sessionId}>
                          Bring {session.tableId} here (₹
                          {calculatePosBill(session).grandTotal})
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>

              <ul className="max-h-72 space-y-2 overflow-y-auto">
                {activeSession.lines.length === 0 && (
                  <li className="flex items-center justify-between gap-2 text-xs">
                    <span className="opacity-60">No items added yet.</span>
                    <button
                      type="button"
                      data-testid="pos-release-table"
                      onClick={() => {
                        updateActiveSession(releaseTable);
                        setActiveTableId(null);
                      }}
                      className="min-h-11 rounded-xl border border-white/15 px-3 text-xs font-bold hover:bg-white/5"
                    >
                      Free this table
                    </button>
                  </li>
                )}
                {activeSession.lines.map((line) => (
                  <li
                    key={line.lineId}
                    data-testid={`pos-line-${line.itemId}`}
                    className="rounded-xl border border-white/10 bg-[#0E131D] p-2.5"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <DietaryMark dietary={line.dietary} />
                          <span className="truncate text-xs font-bold">{line.name}</span>
                        </div>
                        <div className="mt-0.5 text-[10px] text-white/70">
                          ₹{line.unitPrice} ×{" "}
                          {line.kotNumber === null ? (
                            <span className="text-amber-400">pending</span>
                          ) : (
                            <span className="text-emerald-400">KOT #{line.kotNumber}</span>
                          )}
                        </div>
                        {line.note && line.kotNumber !== null && (
                          <div className="mt-0.5 text-[10px] italic text-amber-300">
                            Note: {line.note}
                          </div>
                        )}
                      </div>
                      <span className="text-xs font-black">
                        ₹{line.unitPrice * line.quantity}
                      </span>
                    </div>

                    {line.kotNumber === null && (
                      <div className="mt-1.5">
                        <input
                          type="text"
                          aria-label={`Cooking note for ${line.name}`}
                          value={line.note}
                          onChange={(event) =>
                            updateActiveSession((session) =>
                              setLineNote(session, line.lineId, event.target.value)
                            )
                          }
                          placeholder="Note: less spicy, Jain, no onion"
                          className="min-h-11 w-full rounded-lg border border-white/10 bg-[#121721] px-3 text-base outline-none sm:text-xs"
                        />
                      </div>
                    )}

                    <div className="mt-2 flex items-center justify-between">
                      <div className="flex items-center overflow-hidden rounded-lg border border-white/15">
                        <button
                          type="button"
                          aria-label={`Reduce ${line.name}`}
                          onClick={() =>
                            updateActiveSession((session) =>
                              setLineQuantity(session, line.lineId, line.quantity - 1)
                            )
                          }
                          className="flex h-11 w-11 items-center justify-center hover:bg-white/10"
                        >
                          <Minus className="h-4 w-4" />
                        </button>
                        <span className="min-w-8 text-center text-sm font-black">{line.quantity}</span>
                        <button
                          type="button"
                          aria-label={`Add ${line.name}`}
                          onClick={() =>
                            updateActiveSession((session) =>
                              setLineQuantity(session, line.lineId, line.quantity + 1)
                            )
                          }
                          className="flex h-11 w-11 items-center justify-center hover:bg-white/10"
                        >
                          <Plus className="h-4 w-4" />
                        </button>
                      </div>

                      <button
                        type="button"
                        onClick={() => {
                          if (line.kotNumber === null) {
                            updateActiveSession((session) =>
                              setLineQuantity(session, line.lineId, 0)
                            );
                          } else {
                            setVoidTarget({ lineId: line.lineId, name: line.name });
                          }
                        }}
                        className="flex min-h-11 items-center gap-1 rounded-lg px-3 text-xs font-bold text-rose-400 hover:bg-rose-500/15"
                      >
                        {line.kotNumber === null ? (
                          <>
                            <Trash2 className="h-3.5 w-3.5" /> Remove
                          </>
                        ) : (
                          <>
                            <Ban className="h-3.5 w-3.5" /> Void
                          </>
                        )}
                      </button>
                    </div>
                  </li>
                ))}
              </ul>

              <div className="grid grid-cols-2 gap-2 text-[11px]">
                <label className="space-y-1">
                  <span className="opacity-60">Discount %</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={100}
                    value={activeSession.discountPercent}
                    onChange={(event) =>
                      updateActiveSession((session) =>
                        setSessionCharges(session, {
                          discountPercent: Number(event.target.value),
                        })
                      )
                    }
                    onFocus={(event) => event.currentTarget.select()}
                    className="min-h-11 w-full rounded-lg border border-white/15 bg-[#0E131D] px-3 text-base sm:text-xs"
                  />
                </label>
                <label className="space-y-1">
                  <span className="opacity-60">Service %</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    max={20}
                    value={activeSession.serviceChargePercent}
                    onChange={(event) =>
                      updateActiveSession((session) =>
                        setSessionCharges(session, {
                          serviceChargePercent: Number(event.target.value),
                        })
                      )
                    }
                    onFocus={(event) => event.currentTarget.select()}
                    className="min-h-11 w-full rounded-lg border border-white/15 bg-[#0E131D] px-3 text-base sm:text-xs"
                  />
                </label>
              </div>

              <dl className="space-y-1.5 border-t border-white/10 pt-3 text-xs">
                <div className="flex justify-between opacity-75">
                  <dt>Subtotal ({bill.itemCount} items)</dt>
                  <dd>₹{formatMoney(bill.subtotal)}</dd>
                </div>
                {bill.discountAmount > 0 && (
                  <div className="flex justify-between text-emerald-400">
                    <dt>Discount</dt>
                    <dd>−₹{formatMoney(bill.discountAmount)}</dd>
                  </div>
                )}
                {bill.serviceCharge > 0 && (
                  <div className="flex justify-between opacity-75">
                    <dt>Service charge</dt>
                    <dd>₹{formatMoney(bill.serviceCharge)}</dd>
                  </div>
                )}
                {bill.cgstRateBps + bill.sgstRateBps > 0 && (
                  <>
                    <div className="flex justify-between opacity-75">
                      <dt>CGST {bill.cgstRateBps / 100}%</dt>
                      <dd>₹{formatMoney(bill.cgst)}</dd>
                    </div>
                    <div className="flex justify-between opacity-75">
                      <dt>SGST {bill.sgstRateBps / 100}%</dt>
                      <dd>₹{formatMoney(bill.sgst)}</dd>
                    </div>
                  </>
                )}
                <div className="flex justify-between opacity-60">
                  <dt>Round off</dt>
                  <dd>₹{formatMoney(bill.roundOff)}</dd>
                </div>
                <div className="flex justify-between border-t border-white/10 pt-2 text-base font-black">
                  <dt>Total</dt>
                  <dd data-testid="pos-grand-total" className="text-emerald-400">
                    ₹{bill.grandTotal}
                  </dd>
                </div>
                <div className="flex justify-between text-[11px] opacity-60">
                  <dt>Per guest ({activeSession.guestCount})</dt>
                  <dd>₹{bill.perGuest}</dd>
                </div>
              </dl>

              <div className="grid gap-2">
                <button
                  type="button"
                  data-testid="pos-send-kitchen"
                  onClick={handleSendToKitchen}
                  disabled={pendingCount === 0}
                  className="flex min-h-12 items-center justify-center gap-2 rounded-xl bg-amber-500 text-sm font-black text-black disabled:opacity-40"
                >
                  <ChefHat className="h-4 w-4" />
                  Send to Kitchen{pendingCount > 0 ? ` (${pendingCount})` : ""}
                </button>

                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    data-testid="pos-open-split"
                    onClick={() => setSplitModalOpen(true)}
                    disabled={activeSession.lines.length === 0}
                    className="flex min-h-11 items-center justify-center gap-1 rounded-xl border border-white/15 text-xs font-bold disabled:opacity-40"
                  >
                    <Split className="h-3.5 w-3.5" />
                    Split Bill
                  </button>
                  <button
                    type="button"
                    data-testid="pos-open-bill"
                    onClick={() => setReceiptSessionId(activeSession.sessionId)}
                    disabled={activeSession.lines.length === 0}
                    className="flex min-h-11 items-center justify-center gap-1 rounded-xl border border-white/15 text-xs font-bold disabled:opacity-40"
                  >
                    <Receipt className="h-3.5 w-3.5" />
                    Send / Print
                  </button>
                  <button
                    type="button"
                    data-testid="pos-settle"
                    onClick={() => {
                      setError(null);
                      setPaymentMethod("CASH");
                      setTendered(String(bill.grandTotal));
                      setSettleOpen(true);
                    }}
                    disabled={activeSession.lines.length === 0}
                    className="flex min-h-11 items-center justify-center gap-1 rounded-xl bg-emerald-500 text-xs font-black text-black disabled:opacity-40"
                  >
                    <Wallet className="h-3.5 w-3.5" />
                    Settle
                  </button>
                </div>

                {smsGuest?.phone && activeSession.lines.length > 0 && (
                  <SendBill
                    phone={smsGuest.phone}
                    testId="pos-sms-bill"
                    label={`SMS bill ₹${bill.grandTotal} to ${smsGuest.name || displayMobile(smsGuest.phone)}`}
                    text={billSmsText({
                      outletName: activeSession.outletName,
                      tableId: activeSession.tableId,
                      guestName: smsGuest.name,
                      total: bill.grandTotal,
                      guestCount: activeSession.guestCount,
                      share: null,
                      paid: false,
                      link: tableLink,
                    })}
                  />
                )}
                {activeSession.guestCount > 1 && activeSession.lines.length > 0 && (
                  <p className="text-[11px] opacity-60">
                    Paying separately? Split Bill shows each guest's share and texts it to them.
                  </p>
                )}
              </div>

              {activeSession.tickets.length > 0 && (
                <details className="text-[11px] opacity-70">
                  <summary className="min-h-11 cursor-pointer py-3 font-bold">
                    Kitchen tickets ({activeSession.tickets.length})
                  </summary>
                  <ul className="mt-1 space-y-1">
                    {activeSession.tickets.map((ticket) => (
                      <li key={ticket.kotNumber} className="flex items-center justify-between gap-2">
                        <span>
                          KOT #{ticket.kotNumber} · {ticket.lines.length} items
                          {ticket.mergedFrom ? ` · from ${ticket.mergedFrom}` : ""}
                        </span>
                        <button
                          type="button"
                          data-testid={`pos-reprint-kot-${ticket.kotNumber}`}
                          onClick={() => handleReprintTicket(ticket.kotNumber)}
                          className="flex min-h-11 items-center gap-1 rounded-lg border border-white/15 px-3 font-bold hover:bg-white/10"
                        >
                          <Printer className="h-3 w-3" /> Reprint
                        </button>
                      </li>
                    ))}
                  </ul>
                </details>
              )}

              {activeSession.voids.length > 0 && (
                <details className="text-[11px] opacity-70">
                  <summary className="min-h-11 cursor-pointer py-3 font-bold">
                    Voided items ({activeSession.voids.length})
                  </summary>
                  <ul className="mt-1 space-y-1">
                    {activeSession.voids.map((record, index) => (
                      <li key={`${record.name}-${index}`}>
                        {record.quantity} × {record.name} — {record.reason}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
        </section>
      </main>

      {/* On a phone the bill sits below a long menu; this keeps the total and next step in reach. */}
      {activeSession && bill && (
        <div
          data-testid="pos-phone-bar"
          className="pos-no-print fixed inset-x-0 bottom-0 z-40 border-t border-white/10 bg-[#0A0D12]/95 px-4 py-3 backdrop-blur lg:hidden"
        >
          <div className="mx-auto flex max-w-xl items-center gap-2">
            <button
              type="button"
              onClick={() => scrollToOnPhone("bill-heading")}
              className="min-w-0 flex-1 text-left"
            >
              <div className="truncate text-[11px] opacity-70">
                Table {activeSession.tableId} · {bill.itemCount} item{bill.itemCount === 1 ? "" : "s"}
              </div>
              <div className="text-lg font-black text-emerald-400">₹{bill.grandTotal}</div>
            </button>
            {pendingCount > 0 && (
              <button
                type="button"
                onClick={handleSendToKitchen}
                className="flex min-h-11 items-center gap-1.5 rounded-xl bg-amber-500 px-3 text-xs font-black text-black"
              >
                <ChefHat className="h-4 w-4" />
                Kitchen ({pendingCount})
              </button>
            )}
            <button
              type="button"
              onClick={() => scrollToOnPhone("bill-heading")}
              className="min-h-11 rounded-xl border border-white/15 px-3 text-xs font-black"
            >
              View bill
            </button>
          </div>
        </div>
      )}

      {/* Seat guests */}
      {openTableForm && (
        <OverlayDialog
          isOpen
          onClose={() => setOpenTableForm(null)}
          label="Seat guests"
          className={POS_FORM_DIALOG}
          closeOnBackdrop={false}
        >
          <form
            onSubmit={handleOpenTable}
            className="space-y-4 rounded-2xl border border-white/15 bg-[#121721] p-5"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-black">Seat guests at {openTableForm.tableId}</h2>
              <button
                type="button"
                aria-label="Cancel"
                onClick={() => setOpenTableForm(null)}
                className={POS_CLOSE_BUTTON}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <label className="block space-y-1 text-xs">
              <span className="opacity-70">Number of guests</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={50}
                required
                value={guestCount}
                onChange={(event) => setGuestCount(Number(event.target.value))}
                onFocus={(event) => event.currentTarget.select()}
                className="min-h-11 w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 text-base"
              />
            </label>

            <label className="block space-y-1 text-xs">
              <span className="opacity-70">Steward / server</span>
              <input
                type="text"
                required
                value={serverName}
                onChange={(event) => setServerName(event.target.value)}
                className="min-h-11 w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 text-base"
              />
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="block space-y-1 text-xs">
                <span className="opacity-70">Guest name (optional)</span>
                <input
                  type="text"
                  data-testid="pos-lead-guest-name"
                  maxLength={40}
                  autoComplete="off"
                  value={leadGuestName}
                  onChange={(event) => setLeadGuestName(event.target.value)}
                  className="min-h-11 w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 text-base"
                />
              </label>
              <label className="block space-y-1 text-xs">
                <span className="opacity-70">Mobile (optional)</span>
                <input
                  type="tel"
                  inputMode="tel"
                  data-testid="pos-lead-guest-phone"
                  maxLength={16}
                  autoComplete="off"
                  value={leadGuestPhone}
                  onChange={(event) => setLeadGuestPhone(event.target.value)}
                  placeholder="10 digits"
                  className="min-h-11 w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 text-base"
                />
              </label>
            </div>
            <p className="text-[11px] opacity-60">
              Ask first. The number is used only to text this table its bill.
            </p>

            {error && (
              <p role="alert" className="text-xs text-rose-400">
                {error}
              </p>
            )}

            <button
              type="submit"
              data-testid="pos-confirm-open-table"
              className="min-h-12 w-full rounded-xl bg-emerald-500 text-sm font-black text-black"
            >
              Open Table
            </button>
          </form>
        </OverlayDialog>
      )}

      {/* Void reason */}
      {voidTarget && (
        <OverlayDialog
          isOpen
          onClose={() => {
            setVoidTarget(null);
            setVoidReason("");
          }}
          label="Void item"
          className={POS_FORM_DIALOG}
          closeOnBackdrop={false}
        >
          <form
            onSubmit={handleVoid}
            className="space-y-4 rounded-2xl border border-white/15 bg-[#121721] p-5"
          >
            <h2 className="text-base font-black">Void {voidTarget.name}</h2>
            <p className="text-xs opacity-65">
              This item is already with the kitchen, so the reason is recorded on the bill.
            </p>
            <input
              type="text"
              required
              autoFocus
              aria-label="Reason"
              value={voidReason}
              onChange={(event) => setVoidReason(event.target.value)}
              placeholder="e.g. Guest changed order"
              className="min-h-11 w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 text-base"
            />
            {error && (
              <p role="alert" className="text-xs text-rose-400">
                {error}
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setVoidTarget(null);
                  setVoidReason("");
                }}
                className="min-h-11 rounded-xl border border-white/15 text-sm font-bold"
              >
                Cancel
              </button>
              <button type="submit" className="min-h-11 rounded-xl bg-rose-500 text-sm font-black text-black">
                Void Item
              </button>
            </div>
          </form>
        </OverlayDialog>
      )}

      {/* Settle payment */}
      {settleOpen && activeSession && bill && (
        <OverlayDialog
          isOpen
          onClose={() => setSettleOpen(false)}
          label="Settle bill"
          className={POS_FORM_DIALOG}
          closeOnBackdrop={false}
        >
          <form
            onSubmit={handleSettle}
            className="space-y-4 rounded-2xl border border-white/15 bg-[#121721] p-5"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-black">Settle Table {activeSession.tableId}</h2>
              <button
                type="button"
                aria-label="Cancel"
                onClick={() => setSettleOpen(false)}
                className={POS_CLOSE_BUTTON}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="rounded-xl bg-[#0E131D] p-3 text-center">
              <div className="text-[11px] opacity-60">Amount payable</div>
              <div className="text-2xl font-black text-emerald-400">₹{bill.grandTotal}</div>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {(["CASH", "CARD", "UPI"] as const).map((method) => (
                <button
                  key={method}
                  type="button"
                  data-testid={`pos-payment-${method}`}
                  aria-pressed={paymentMethod === method}
                  onClick={() => {
                    setPaymentMethod(method);
                    setTendered(String(bill.grandTotal));
                  }}
                  className={`min-h-11 rounded-xl border py-2 text-xs font-bold ${
                    paymentMethod === method
                      ? "border-emerald-400 bg-emerald-500/20 text-emerald-300"
                      : "border-white/15"
                  }`}
                >
                  {method}
                </button>
              ))}
            </div>

            {paymentMethod === "CASH" && (
              <label className="block space-y-1 text-xs">
                <span className="opacity-70">Cash received</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={bill.grandTotal}
                  value={tendered}
                  onChange={(event) => setTendered(event.target.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  className="min-h-11 w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 text-base font-black"
                />
                <span className="block pt-1 text-[11px] opacity-70">
                  Change due:{" "}
                  <strong className="text-emerald-400">
                    ₹{Math.max(0, Number(tendered || 0) - bill.grandTotal)}
                  </strong>
                </span>
              </label>
            )}

            {error && (
              <p role="alert" className="text-xs text-rose-400">
                {error}
              </p>
            )}

            <button
              type="submit"
              data-testid="pos-confirm-settle"
              className="min-h-12 w-full rounded-xl bg-emerald-500 text-sm font-black text-black"
            >
              Confirm Payment & Close Table
            </button>
          </form>
        </OverlayDialog>
      )}

      {/* Kitchen ticket */}
      {kitchenTicket && (
        <OverlayDialog
          isOpen
          onClose={() => setKitchenTicket(null)}
          label="Kitchen ticket"
          className={POS_PAPER_DIALOG}
        >
          <div className="pos-receipt rounded-2xl bg-white p-5 font-mono text-xs text-black">
            <div className="text-center">
              <div className="text-sm font-black">
                {isReprint ? "KITCHEN TICKET — REPRINT" : "KITCHEN ORDER TICKET"}
              </div>
              <div>KOT #{kitchenTicket.kotNumber}</div>
              <div>
                Table {kitchenTicket.tableId} · {kitchenTicket.serverName}
              </div>
              <div>{new Date(kitchenTicket.firedAt).toLocaleString()}</div>
              {kitchenTicket.mergedFrom && (
                <div className="font-bold">Merged from {kitchenTicket.mergedFrom}</div>
              )}
            </div>
            <hr className="my-2 border-dashed border-black/40" />
            <ul className="space-y-1">
              {kitchenTicket.lines.map((line, index) => (
                <li key={`${line.name}-${index}`}>
                  <div className="flex justify-between">
                    <span>{line.name}</span>
                    <strong>×{line.quantity}</strong>
                  </div>
                  {line.note && <div className="pl-2 italic">↳ {line.note}</div>}
                </li>
              ))}
            </ul>
            <hr className="my-2 border-dashed border-black/40" />
            <div className="pos-no-print grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => window.print()}
                className="flex min-h-11 items-center justify-center gap-1 rounded-lg border border-black/20 font-bold"
              >
                <Printer className="h-3.5 w-3.5" /> Print
              </button>
              <button
                type="button"
                data-testid="pos-close-kot"
                onClick={() => setKitchenTicket(null)}
                className="min-h-11 rounded-lg bg-black font-bold text-white"
              >
                Done
              </button>
            </div>
          </div>
        </OverlayDialog>
      )}

      {/* Bill / receipt */}
      {receiptSession && receiptBill && (
        <OverlayDialog
          isOpen
          onClose={() => setReceiptSessionId(null)}
          label="Bill"
          className={POS_PAPER_DIALOG}
        >
          <div className="pos-receipt rounded-2xl bg-white p-5 font-mono text-[11px] text-black">
            <PosReceiptPaper
              session={receiptSession}
              bill={receiptBill}
              billNumber={billNumbers[receiptSession.sessionId] ?? null}
              claimCode={claimCodes[receiptSession.sessionId] ?? null}
              registrations={{
                fssaiNumber: receiptOutlet?.fssaiNumber ?? "",
                gstin: receiptOutlet?.gstin ?? "",
              }}
            />

            <div className="pos-no-print mt-4 space-y-2">
              <h3 className="font-sans text-xs font-black uppercase tracking-wide text-black/70">Send bill</h3>
              {receiptSmsGuests.map((guest) =>
                editingGuest === `${receiptSession.sessionId}:${guest.seat}` ? (
                  <GuestContactEditor
                    key={guest.seat}
                    seat={guest.seat}
                    guest={guest}
                    tone="light"
                    onSave={(input) => saveGuest(receiptSession.sessionId, guest.seat, input)}
                    onDone={() => setEditingGuest(null)}
                  />
                ) : (
                  <div key={guest.seat} className="space-y-1.5 rounded-xl border border-black/10 p-2 font-sans">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="min-w-0 truncate">
                        <strong>{guest.name || "Guest"}</strong> · {displayMobile(guest.phone)}
                      </span>
                      <button
                        type="button"
                        data-testid={`pos-receipt-edit-${guest.seat}`}
                        aria-label={`Edit ${guest.name || "guest"}'s number`}
                        onClick={() => setEditingGuest(`${receiptSession.sessionId}:${guest.seat}`)}
                        className="flex min-h-11 shrink-0 items-center gap-1 rounded-lg border border-black/20 px-3 font-bold"
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                        Edit
                      </button>
                    </div>
                    <SendBill
                      phone={guest.phone}
                      testId={`pos-receipt-sms-${guest.seat}`}
                      label={`SMS ₹${receiptBill.grandTotal}`}
                      text={billSmsText({
                        outletName: receiptSession.outletName,
                        tableId: receiptSession.tableId,
                        guestName: guest.name,
                        total: receiptBill.grandTotal,
                        guestCount: receiptSession.guestCount,
                        share: null,
                        paid: receiptSession.status === "SETTLED",
                        link: receiptLink,
                      })}
                    />
                  </div>
                )
              )}
              {receiptSmsGuests.length === 0 && (
                <SendToNumber
                  testId="pos-receipt-quick"
                  numberTestId="pos-receipt-number"
                  label={`SMS ₹${receiptBill.grandTotal}`}
                  text={billSmsText({
                    outletName: receiptSession.outletName,
                    tableId: receiptSession.tableId,
                    guestName: receiptSession.guests.find((guest) => guest.seat === 1)?.name ?? "",
                    total: receiptBill.grandTotal,
                    guestCount: receiptSession.guestCount,
                    share: null,
                    paid: receiptSession.status === "SETTLED",
                    link: receiptLink,
                  })}
                  onSend={(phone) => {
                    const name = receiptSession.guests.find((guest) => guest.seat === 1)?.name ?? "";
                    // After the messaging app has opened, keep the number on the table for a resend.
                    setTimeout(() => saveGuest(receiptSession.sessionId, 1, { name, phone }), 0);
                  }}
                />
              )}
              <BillEmailAndPdf
                sessionId={receiptSession.sessionId}
                fingerprint={receiptFingerprint}
                link={receiptLink}
                signedIn={signedIn}
                mailEnabled={mailEnabled}
                testId="pos-receipt"
              />
            </div>

            {receiptSession.status === "SETTLED" && (
              <div className="pos-no-print mt-4 space-y-1 font-sans">
                {receiptSession.shiftId && receiptSession.shiftId !== activeShift?.shiftId ? (
                  <p className="text-center text-[11px] text-black/60">
                    This bill is in a closed shift, so it can no longer be changed.
                  </p>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      data-testid="pos-change-payment"
                      onClick={() =>
                        setOwnerAction({ kind: "payment", sessionId: receiptSession.sessionId })
                      }
                      className="flex min-h-11 items-center justify-center gap-1 rounded-lg border border-black/20 text-xs font-bold"
                    >
                      <Lock className="h-3.5 w-3.5" aria-hidden="true" /> Change payment
                    </button>
                    <button
                      type="button"
                      data-testid="pos-reopen-bill"
                      onClick={() =>
                        setOwnerAction({ kind: "reopen", sessionId: receiptSession.sessionId })
                      }
                      className="flex min-h-11 items-center justify-center gap-1 rounded-lg border border-black/20 text-xs font-bold"
                    >
                      <Lock className="h-3.5 w-3.5" aria-hidden="true" /> Reopen bill
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="pos-no-print mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => window.print()}
                className="flex min-h-11 items-center justify-center gap-1 rounded-lg border border-black/20 font-bold"
              >
                <Printer className="h-3.5 w-3.5" /> Print
              </button>
              <button
                type="button"
                data-testid="pos-close-receipt"
                onClick={() => setReceiptSessionId(null)}
                className="flex min-h-11 items-center justify-center gap-1 rounded-lg bg-black font-bold text-white"
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> Close
              </button>
            </div>
          </div>
        </OverlayDialog>
      )}

      {ownerAction &&
        (() => {
          const target = sessions.find((session) => session.sessionId === ownerAction.sessionId);
          if (!target?.payment) return null;
          return (
            <PosOwnerApproval
              kind={ownerAction.kind}
              outletId={target.outletId}
              tableId={target.tableId}
              total={calculatePosBill(target).grandTotal}
              currentMethod={target.payment.method}
              onApply={(correction) => applyOwnerCorrection(target.sessionId, correction)}
              onClose={() => setOwnerAction(null)}
            />
          );
        })()}

      {/* Interactive Guest Bill Splitter Modal */}
      {splitModalOpen && activeSession && bill && (
        <OverlayDialog
          isOpen
          onClose={() => setSplitModalOpen(false)}
          label="Split bill by guest"
          className="pos-no-print m-auto w-full max-w-xl bg-transparent p-4 text-white backdrop:bg-black/80"
          closeOnBackdrop={false}
        >
          <div className="space-y-4 rounded-2xl border border-white/15 bg-[#121721] p-5">
            <div className="flex items-start justify-between gap-2">
              <div>
                <h2 className="text-base font-black">
                  Split Bill — Table {activeSession.tableId} ({activeSession.guestCount} Guests)
                </h2>
                <p className="text-xs opacity-65">
                  Give each dish to one guest or share it. Add a guest&apos;s mobile number to text
                  them their share from this phone.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close split calculator"
                onClick={() => setSplitModalOpen(false)}
                className={POS_CLOSE_BUTTON}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
              {activeSession.lines.map((line) => (
                <div
                  key={line.lineId}
                  className="flex flex-col gap-2 rounded-xl border border-white/10 bg-[#0E131D] p-2.5 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-3"
                >
                  <div>
                    <div className="font-bold">
                      {line.quantity} × {line.name}
                    </div>
                    <div className="text-[11px] opacity-65">
                      ₹{line.unitPrice * line.quantity}
                    </div>
                  </div>
                  <select
                    aria-label={`Assign ${line.name}`}
                    value={lineAssignments[line.lineId] ?? 0}
                    onChange={(event) =>
                      setLineAssignments((prev) => ({
                        ...prev,
                        [line.lineId]: Number(event.target.value),
                      }))
                    }
                    className="min-h-11 rounded-lg border border-white/15 bg-[#121721] px-2.5 text-base font-bold sm:text-xs"
                  >
                    <option value={0}>Shared Equally (All Guests)</option>
                    {guestSplitShares.map((share) => (
                      <option key={share.guestIndex} value={share.guestIndex}>
                        {share.guestLabel} only
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {guestSplitShares.map((share) => (
                <PosGuestCard
                  key={`${activeSession.sessionId}-${share.guestIndex}`}
                  share={share}
                  guest={activeSession.guests.find((guest) => guest.seat === share.guestIndex)}
                  outletName={activeSession.outletName}
                  tableId={activeSession.tableId}
                  guestCount={activeSession.guestCount}
                  total={bill.grandTotal}
                  onSave={(input) => saveGuest(activeSession.sessionId, share.guestIndex, input)}
                />
              ))}
            </div>

            <div className="flex justify-between gap-2 border-t border-white/10 pt-3">
              <button
                type="button"
                onClick={() => setLineAssignments({})}
                className="min-h-11 rounded-xl border border-white/15 px-3 text-xs font-bold"
              >
                Reset to Equal Split
              </button>
              <button
                type="button"
                data-testid="pos-close-split"
                onClick={() => setSplitModalOpen(false)}
                className="min-h-11 rounded-xl bg-emerald-500 px-5 text-sm font-black text-black"
              >
                Done
              </button>
            </div>
          </div>
        </OverlayDialog>
      )}

      {salesOpen && (
        <PosSalesHistory
          outletId={outletId}
          outletName={currentOutlet.name}
          registrations={{ fssaiNumber: currentOutlet.fssaiNumber, gstin: currentOutlet.gstin }}
          seesAllSales={seesAllSales}
          mailEnabled={mailEnabled}
          localSessions={sessions}
          onClose={() => setSalesOpen(false)}
        />
      )}

      {/* Shift open / cash-up */}
      {shiftFormOpen && (
        <OverlayDialog
          isOpen
          onClose={() => setShiftFormOpen(false)}
          label={activeShift ? "Close shift" : "Open shift"}
          className={POS_FORM_DIALOG}
          closeOnBackdrop={false}
        >
          <form
            onSubmit={activeShift ? handleCloseShift : handleOpenShift}
            className="space-y-4 rounded-2xl border border-white/15 bg-[#121721] p-5"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-black">
                {activeShift ? "Close shift & count cash" : "Open shift"}
              </h2>
              <button
                type="button"
                aria-label="Cancel"
                onClick={() => setShiftFormOpen(false)}
                className={POS_CLOSE_BUTTON}
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <label className="block space-y-1 text-xs">
              <span className="opacity-70">Cashier</span>
              <input
                type="text"
                required
                value={cashierName}
                onChange={(event) => setCashierName(event.target.value)}
                className="min-h-11 w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 text-base"
              />
            </label>

            {activeShift ? (
              <>
                <dl className="space-y-1 rounded-xl bg-[#0E131D] p-3 text-xs">
                  <div className="flex justify-between opacity-70">
                    <dt>Opening float</dt>
                    <dd>₹{activeShift.openingCash}</dd>
                  </div>
                  <div className="flex justify-between opacity-70">
                    <dt>Cash settled this shift</dt>
                    <dd>
                      ₹
                      {formatMoney(
                        summarizeShift(getShiftSessions(activeShift, sessions)).byPaymentMethod.CASH
                      )}
                    </dd>
                  </div>
                </dl>
                <label className="block space-y-1 text-xs">
                  <span className="opacity-70">Cash counted in the drawer</span>
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    required
                    value={countedCash}
                    onChange={(event) => setCountedCash(event.target.value)}
                    onFocus={(event) => event.currentTarget.select()}
                    className="min-h-11 w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 text-base font-black"
                  />
                </label>
                <p className="text-[11px] opacity-60">
                  Open tables are not settled by closing a shift; they carry over.
                </p>
              </>
            ) : (
              <label className="block space-y-1 text-xs">
                <span className="opacity-70">Opening cash float (₹)</span>
                <input
                  type="number"
                  inputMode="decimal"
                  min={0}
                  required
                  value={openingCash}
                  onChange={(event) => setOpeningCash(event.target.value)}
                  className="min-h-11 w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 text-base font-black"
                />
              </label>
            )}

            {error && (
              <p role="alert" className="text-xs text-rose-400">
                {error}
              </p>
            )}

            <button
              type="submit"
              data-testid="pos-confirm-shift"
              className="min-h-12 w-full rounded-xl bg-emerald-500 text-sm font-black text-black"
            >
              {activeShift ? "Close Shift & Print Z-Report" : "Open Shift"}
            </button>
          </form>
        </OverlayDialog>
      )}

      {/* Z-report */}
      {zReport && (
        <OverlayDialog
          isOpen
          onClose={() => setZReport(null)}
          label="Z report"
          className={POS_PAPER_DIALOG}
          closeOnBackdrop={false}
        >
          <div
            data-testid="pos-z-report"
            className="pos-receipt rounded-2xl bg-white p-5 font-mono text-[11px] text-black"
          >
            <div className="text-center">
              <div className="text-sm font-black">Z-REPORT</div>
              <div>{zReport.outletName}</div>
              <div>Opened {new Date(zReport.openedAt).toLocaleString()}</div>
              <div>Closed {new Date(zReport.closedAt).toLocaleString()}</div>
              <div>
                {zReport.openedBy} → {zReport.closedBy}
              </div>
            </div>

            <hr className="my-2 border-dashed border-black/40" />

            <div className="space-y-0.5">
              <div className="flex justify-between">
                <span>Bills settled</span>
                <span>{zReport.summary.settledBills}</span>
              </div>
              <div className="flex justify-between">
                <span>Covers</span>
                <span>{zReport.summary.covers}</span>
              </div>
              <div className="flex justify-between">
                <span>Gross sales</span>
                <span>{formatMoney(zReport.summary.grossSales)}</span>
              </div>
              <div className="flex justify-between">
                <span>Tax collected</span>
                <span>{formatMoney(zReport.summary.taxCollected)}</span>
              </div>
              <div className="flex justify-between">
                <span>Discounts given</span>
                <span>{formatMoney(zReport.summary.discountsGiven)}</span>
              </div>
              <div className="flex justify-between">
                <span>Average bill</span>
                <span>{formatMoney(zReport.summary.averageBill)}</span>
              </div>
              <div className="flex justify-between">
                <span>Voids</span>
                <span>{zReport.voidCount}</span>
              </div>
              <div className="flex justify-between">
                <span>Tables still open</span>
                <span>{zReport.openTablesAtClose}</span>
              </div>
            </div>

            <hr className="my-2 border-dashed border-black/40" />

            <div className="space-y-0.5">
              <div className="flex justify-between">
                <span>Cash</span>
                <span>{formatMoney(zReport.summary.byPaymentMethod.CASH)}</span>
              </div>
              <div className="flex justify-between">
                <span>Card</span>
                <span>{formatMoney(zReport.summary.byPaymentMethod.CARD)}</span>
              </div>
              <div className="flex justify-between">
                <span>UPI</span>
                <span>{formatMoney(zReport.summary.byPaymentMethod.UPI)}</span>
              </div>
            </div>

            <hr className="my-2 border-dashed border-black/40" />

            <div className="space-y-0.5">
              <div className="flex justify-between">
                <span>Opening float</span>
                <span>{formatMoney(zReport.openingCash)}</span>
              </div>
              <div className="flex justify-between">
                <span>Expected in drawer</span>
                <span>{formatMoney(zReport.expectedCash)}</span>
              </div>
              <div className="flex justify-between">
                <span>Counted</span>
                <span>{formatMoney(zReport.countedCash)}</span>
              </div>
              <div className="flex justify-between border-t border-black/40 pt-1 text-sm font-black">
                <span>Variance</span>
                <span data-testid="pos-z-variance">{formatMoney(zReport.cashVariance)}</span>
              </div>
            </div>

            <p className="mt-3 text-center text-[9px]">
              Offline demo terminal — not a government-registered fiscal report.
            </p>

            <div className="pos-no-print mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => window.print()}
                className="flex min-h-11 items-center justify-center gap-1 rounded-lg border border-black/20 font-bold"
              >
                <Printer className="h-3.5 w-3.5" /> Print
              </button>
              <button
                type="button"
                data-testid="pos-close-z-report"
                onClick={() => setZReport(null)}
                className="flex min-h-11 items-center justify-center gap-1 rounded-lg bg-black font-bold text-white"
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> Close
              </button>
            </div>
          </div>
        </OverlayDialog>
      )}

      <footer className="pos-no-print mx-auto max-w-[1600px] px-4 pb-8 text-[11px] opacity-50">
        <Leaf className="mr-1 inline h-3 w-3" />
        Offline terminal. Tables, bills and shift totals stay on this device until you clear them.
      </footer>
    </div>
  );
}
