"use client";

import React, { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowRightLeft,
  Ban,
  ChefHat,
  CheckCircle2,
  Clock,
  Leaf,
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
  calculateItemizedSplit,
  calculatePosBill,
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
  restorePosSessions,
  restorePosShift,
  sendPendingToKitchen,
  setLineNote,
  setLineQuantity,
  setSessionCharges,
  setTableGuest,
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
import { BillSmsLink, displayMobile, GuestContactEditor, PosGuestCard } from "./PosGuestCard";
import { DietaryMark, PosMenuGrid } from "./PosMenuGrid";

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

export function PosTerminal({ catalog }: { catalog: PosCatalog }) {
  if (catalog.status === "ready" && catalog.outlets.length > 0) {
    return <PosFloor outlets={catalog.outlets} />;
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
          body: "Set up your restaurant and its menu in the owner workspace, or ask the owner to add you to the team.",
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
            className="inline-flex min-h-11 items-center rounded-xl bg-emerald-700 px-4 text-sm font-black text-white hover:bg-emerald-600"
          >
            {message.action}
          </Link>
        </section>
      </div>
    </main>
  );
}

function PosFloor({ outlets }: { outlets: PosOutlet[] }) {
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

  // localStorage stays the working copy; the server is the durable one when signed in.
  const [syncAccount, setSyncAccount] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<"local" | "pending" | "synced" | "failed">("local");
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const syncRevisions = useRef(new Map<string, number>());

  const [claimCodes, setClaimCodes] = useState<Record<string, string>>({});
  /** `sessionId:seat` of the guest whose name and mobile are being corrected. */
  const [editingGuest, setEditingGuest] = useState<string | null>(null);

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
  const [settledDrawerOpen, setSettledDrawerOpen] = useState(false);

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

  // Adopt the account's stored floor when this device has nothing of its own yet.
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    fetch("/api/webroutes/account/me", { signal: AbortSignal.timeout(8000) })
      .then((response) => (response.ok ? response.json() : null))
      .then(async (account) => {
        if (cancelled || !account) return;
        // The 86 list is outlet-wide, so the counter adopts it whether signed in or not.
        if (Array.isArray(account.unavailableItemIds)) {
          setUnavailableItemIds(
            account.unavailableItemIds.filter((id: unknown): id is string => typeof id === "string")
          );
        }
        if (!account.user) return;
        setSyncAccount(account.user.displayName);
        const response = await fetch("/api/webroutes/pos/state", {
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok || cancelled) return;
        const state = await response.json();
        const stored = restorePosSessions(JSON.stringify(state.sessions ?? [])).filter((session) =>
          isKnownOutlet(session.outletId)
        );
        for (const session of stored) {
          syncRevisions.current.set(session.sessionId, session.revision);
        }
        setSessions((current) => (current.length === 0 ? stored : current));
        const storedShift = restorePosShift(JSON.stringify(state.shift ?? null));
        const adoptableShift = storedShift && isKnownOutlet(storedShift.outletId) ? storedShift : null;
        setActiveShift((current) => current ?? adoptableShift);
        setSyncState("synced");
      })
      .catch(() => {
        // Offline or signed out: the terminal keeps running from this device.
      });
    return () => {
      cancelled = true;
    };
  }, [hydrated]);

  // Push the queue after changes settle, so a burst of taps is one request.
  useEffect(() => {
    if (!hydrated || !syncAccount) return;
    setSyncState("pending");
    const timer = setTimeout(() => {
      const payload = sessions.map((session) => ({
        ...session,
        revision: syncRevisions.current.get(session.sessionId) ?? 0,
      }));
      fetch("/api/webroutes/pos/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ sessions: payload, shift: activeShift }),
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("Sync rejected.");
          const result = await response.json();
          // Revisions live outside React state so adopting them cannot retrigger this effect.
          for (const stored of restorePosSessions(JSON.stringify(result.sessions ?? []))) {
            syncRevisions.current.set(stored.sessionId, stored.revision);
          }
          setSyncState("synced");
          if (result.claimCodes) {
            setClaimCodes((current) => ({ ...current, ...result.claimCodes }));
          }
          // A conflict is recoverable by reloading; a rejection is not, so they read differently.
          const conflict = result.conflicts?.[0];
          const rejection = result.rejected?.[0];
          setSyncMessage(
            conflict?.reason ??
              (rejection
                ? `${result.rejected.length} table(s) could not be saved: ${rejection.reason}`
                : null)
          );
        })
        .catch(() => {
          setSyncState("failed");
        });
    }, 1200);
    return () => clearTimeout(timer);
  }, [sessions, activeShift, hydrated, syncAccount]);

  const currentOutlet = outlets.find((outlet) => outlet.outletId === outletId) ?? outlets[0];
  const menu = currentOutlet.menu;
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

  const settledSessions = useMemo(
    () =>
      sessions
        .filter((session) => session.status === "SETTLED" && session.outletId === outletId)
        .reverse(),
    [sessions, outletId]
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

  const receiptSmsGuests = (receiptSession?.guests ?? []).flatMap((guest) =>
    guest.phone && receiptSession && guest.seat <= receiptSession.guestCount
      ? [{ seat: guest.seat, name: guest.name, phone: guest.phone }]
      : []
  );

  const shift = useMemo(
    () => summarizeShift(sessions.filter((session) => session.outletId === outletId)),
    [sessions, outletId]
  );

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

  function run(action: () => void) {
    try {
      setError(null);
      action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    }
  }

  function updateActiveSession(update: (session: PosTableSession) => PosTableSession) {
    if (!activeSession) {
      setError("Open a table before adding items.");
      return;
    }
    run(() => {
      const next = update(activeSession);
      setSessions((previous) =>
        previous.map((session) => (session.sessionId === next.sessionId ? next : session))
      );
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
      const next = setTableGuest(session, seat, input);
      setSessions((previous) =>
        previous.map((candidate) => (candidate.sessionId === sessionId ? next : candidate))
      );
      return null;
    } catch (caught) {
      return caught instanceof Error ? caught.message : "Could not save this guest.";
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
            className="flex items-center gap-1.5 rounded-xl border border-white/10 px-3 py-2 text-xs font-bold hover:bg-white/5"
          >
            <ArrowLeft className="h-4 w-4" />
            Storefront
          </Link>

          <div>
            <h1 className="text-lg font-black leading-tight">Dine-In Billing Terminal</h1>
            <p className="text-[11px] opacity-60" data-testid="pos-sync-status">
              {syncAccount
                ? syncState === "synced"
                  ? `Works offline · Saved to ${syncAccount}`
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
              className="rounded-xl border border-white/15 bg-[#121721] px-3 py-2 font-bold"
            >
              {outlets.map((outlet) => (
                <option key={outlet.outletId} value={outlet.outletId}>
                  {outlet.name}
                </option>
              ))}
            </select>
          </label>

          <div className="flex flex-wrap gap-2 text-[11px]">
            <span className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5">
              Open tables <strong className="text-emerald-400">{openSessions.length}</strong>
            </span>
            <button
              type="button"
              data-testid="pos-open-settled-history"
              onClick={() => setSettledDrawerOpen(true)}
              className="rounded-lg border border-white/15 bg-white/5 px-2.5 py-1.5 hover:border-emerald-400/50 transition"
            >
              Bills <strong className="text-emerald-400">{shift.settledBills}</strong>
            </button>
            <span className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5">
              Sales <strong className="text-emerald-400">₹{formatMoney(shift.grossSales)}</strong>
            </span>
            <span className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5">
              Covers <strong className="text-emerald-400">{shift.covers}</strong>
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
              className={`rounded-lg border px-2.5 py-1.5 font-bold transition ${
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
                className="flex items-center gap-1 rounded-xl border border-emerald-400/40 bg-emerald-500/15 px-3 py-2 text-xs font-bold text-emerald-300 hover:bg-emerald-500/25"
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
                value={customDishName}
                onChange={(event) => setCustomDishName(event.target.value)}
                placeholder="Custom dish / drink name"
                className="rounded-xl border border-white/15 bg-[#0E131D] px-3 py-2 text-xs sm:col-span-2"
              />
              <input
                type="number"
                required
                min={1}
                max={100000}
                value={customDishPrice}
                onChange={(event) => setCustomDishPrice(event.target.value)}
                placeholder="Price (₹)"
                className="rounded-xl border border-white/15 bg-[#0E131D] px-3 py-2 text-xs"
              />
              <select
                value={customDishDietary}
                onChange={(event) => setCustomDishDietary(event.target.value as DietaryType)}
                aria-label="Dietary type"
                className="rounded-xl border border-white/15 bg-[#0E131D] px-2.5 py-2 text-xs font-bold"
              >
                <option value="veg">Veg</option>
                <option value="non-veg">Non-Veg</option>
                <option value="egg">Egg</option>
              </select>
              <input
                type="text"
                value={customDishNote}
                onChange={(event) => setCustomDishNote(event.target.value)}
                placeholder="Cooking note (optional)"
                className="rounded-xl border border-white/15 bg-[#0E131D] px-3 py-2 text-xs"
              />
              <button
                type="submit"
                data-testid="pos-submit-custom-dish"
                className="rounded-xl bg-emerald-500 px-3 py-2 text-xs font-black text-white"
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
                className="min-h-11 w-full rounded-xl border border-white/15 bg-[#121721] py-2 pl-9 pr-3 text-sm outline-none focus:border-emerald-400/60"
              />
            </div>
            <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
              <button
                type="button"
                onClick={() => {
                  setCategoryFilter(null);
                  revealMenuTop();
                }}
                className={`shrink-0 whitespace-nowrap rounded-xl border px-3 py-2 text-xs font-bold ${
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
                  className={`shrink-0 whitespace-nowrap rounded-xl border px-3 py-2 text-xs font-bold ${
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
            {activeSession && (
              <span className="text-[11px] opacity-60">{activeSession.serverName}</span>
            )}
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
                      min={1}
                      max={50}
                      value={activeSession.guestCount}
                      onChange={(event) =>
                        updateActiveSession((session) =>
                          setSessionCharges(session, { guestCount: Number(event.target.value) })
                        )
                      }
                      className="w-14 rounded-lg border border-white/15 bg-[#0E131D] px-2 py-1"
                    />
                  </label>
                  <span className="flex items-center gap-1 opacity-60">
                    <Clock className="h-3.5 w-3.5" />
                    {formatElapsed(activeSession.openedAt, now)}
                  </span>
                </div>

                {freeTables.length > 0 && (
                  <label className="flex items-center gap-1 text-[10px]">
                    <ArrowRightLeft className="h-3 w-3 opacity-60" />
                    <select
                      aria-label="Move table"
                      value=""
                      onChange={(event) => handleTransferTable(event.target.value)}
                      className="rounded-lg border border-white/15 bg-[#0E131D] px-2 py-1 font-bold"
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
                  <label className="flex items-center gap-1 text-[10px]">
                    <Merge className="h-3 w-3 opacity-60" />
                    <select
                      aria-label="Merge another table into this bill"
                      data-testid="pos-merge-select"
                      value=""
                      onChange={(event) => handleMergeTable(event.target.value)}
                      className="rounded-lg border border-white/15 bg-[#0E131D] px-2 py-1 font-bold"
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
                        <div className="mt-0.5 text-[10px] opacity-60">
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
                          placeholder="Add note (e.g. Less spicy, Jain, No onion)"
                          className="w-full rounded-lg border border-white/10 bg-[#121721] px-2 py-1 text-[10px] outline-none"
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
                          className="px-2 py-1 hover:bg-white/10"
                        >
                          <Minus className="h-3 w-3" />
                        </button>
                        <span className="px-2.5 text-xs font-black">{line.quantity}</span>
                        <button
                          type="button"
                          aria-label={`Add ${line.name}`}
                          onClick={() =>
                            updateActiveSession((session) =>
                              setLineQuantity(session, line.lineId, line.quantity + 1)
                            )
                          }
                          className="px-2 py-1 hover:bg-white/10"
                        >
                          <Plus className="h-3 w-3" />
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
                        className="flex items-center gap-1 rounded-lg px-2 py-1 text-[10px] font-bold text-rose-400 hover:bg-rose-500/15"
                      >
                        {line.kotNumber === null ? (
                          <>
                            <Trash2 className="h-3 w-3" /> Remove
                          </>
                        ) : (
                          <>
                            <Ban className="h-3 w-3" /> Void
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
                    className="w-full rounded-lg border border-white/15 bg-[#0E131D] px-2 py-1.5"
                  />
                </label>
                <label className="space-y-1">
                  <span className="opacity-60">Service %</span>
                  <input
                    type="number"
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
                    className="w-full rounded-lg border border-white/15 bg-[#0E131D] px-2 py-1.5"
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
                  className="flex items-center justify-center gap-2 rounded-xl bg-amber-500 py-2.5 text-xs font-black text-black disabled:opacity-40"
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
                    className="flex items-center justify-center gap-1 rounded-xl border border-white/15 py-2.5 text-xs font-bold disabled:opacity-40"
                  >
                    <Split className="h-3.5 w-3.5" />
                    Split Bill
                  </button>
                  <button
                    type="button"
                    onClick={() => setReceiptSessionId(activeSession.sessionId)}
                    disabled={activeSession.lines.length === 0}
                    className="flex items-center justify-center gap-1 rounded-xl border border-white/15 py-2.5 text-xs font-bold disabled:opacity-40"
                  >
                    <Receipt className="h-3.5 w-3.5" />
                    Print Bill
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
                    className="flex items-center justify-center gap-1 rounded-xl bg-emerald-500 py-2.5 text-xs font-black disabled:opacity-40"
                  >
                    <Wallet className="h-3.5 w-3.5" />
                    Settle
                  </button>
                </div>

                {smsGuest?.phone && activeSession.lines.length > 0 && (
                  <BillSmsLink
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
                  <summary className="cursor-pointer font-bold">
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
                          className="flex items-center gap-1 rounded-lg border border-white/15 px-2 py-1 font-bold hover:bg-white/10"
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
                  <summary className="cursor-pointer font-bold">
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
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Seat guests"
          className="pos-no-print fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <form
            onSubmit={handleOpenTable}
            className="w-full max-w-sm space-y-4 rounded-2xl border border-white/15 bg-[#121721] p-5"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-black">Seat guests at {openTableForm.tableId}</h2>
              <button
                type="button"
                aria-label="Cancel"
                onClick={() => setOpenTableForm(null)}
                className="rounded-lg p-1 hover:bg-white/10"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <label className="block space-y-1 text-xs">
              <span className="opacity-70">Number of guests</span>
              <input
                type="number"
                min={1}
                max={50}
                required
                value={guestCount}
                onChange={(event) => setGuestCount(Number(event.target.value))}
                className="w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 py-2"
              />
            </label>

            <label className="block space-y-1 text-xs">
              <span className="opacity-70">Steward / server</span>
              <input
                type="text"
                required
                value={serverName}
                onChange={(event) => setServerName(event.target.value)}
                className="w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 py-2"
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
                  className="w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 py-2"
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
                  className="w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 py-2"
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
              className="w-full rounded-xl bg-emerald-500 py-2.5 text-xs font-black"
            >
              Open Table
            </button>
          </form>
        </div>
      )}

      {/* Void reason */}
      {voidTarget && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Void item"
          className="pos-no-print fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <form
            onSubmit={handleVoid}
            className="w-full max-w-sm space-y-4 rounded-2xl border border-white/15 bg-[#121721] p-5"
          >
            <h2 className="text-base font-black">Void {voidTarget.name}</h2>
            <p className="text-xs opacity-65">
              This item is already with the kitchen, so the reason is recorded on the bill.
            </p>
            <input
              type="text"
              required
              autoFocus
              value={voidReason}
              onChange={(event) => setVoidReason(event.target.value)}
              placeholder="e.g. Guest changed order"
              className="w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 py-2 text-xs"
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
                className="rounded-xl border border-white/15 py-2.5 text-xs font-bold"
              >
                Cancel
              </button>
              <button type="submit" className="rounded-xl bg-rose-500 py-2.5 text-xs font-black">
                Void Item
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Settle payment */}
      {settleOpen && activeSession && bill && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Settle bill"
          className="pos-no-print fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <form
            onSubmit={handleSettle}
            className="w-full max-w-sm space-y-4 rounded-2xl border border-white/15 bg-[#121721] p-5"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-black">Settle Table {activeSession.tableId}</h2>
              <button
                type="button"
                aria-label="Cancel"
                onClick={() => setSettleOpen(false)}
                className="rounded-lg p-1 hover:bg-white/10"
              >
                <X className="h-4 w-4" />
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
                  onClick={() => {
                    setPaymentMethod(method);
                    setTendered(String(bill.grandTotal));
                  }}
                  className={`rounded-xl border py-2 text-xs font-bold ${
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
                  min={bill.grandTotal}
                  value={tendered}
                  onChange={(event) => setTendered(event.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 py-2 text-base font-black"
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
              className="w-full rounded-xl bg-emerald-500 py-3 text-xs font-black"
            >
              Confirm Payment & Close Table
            </button>
          </form>
        </div>
      )}

      {/* Kitchen ticket */}
      {kitchenTicket && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Kitchen ticket"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <div className="pos-receipt w-full max-w-xs rounded-2xl border border-white/15 bg-white p-5 font-mono text-xs text-black">
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
                className="flex items-center justify-center gap-1 rounded-lg border border-black/20 py-2 font-bold"
              >
                <Printer className="h-3.5 w-3.5" /> Print
              </button>
              <button
                type="button"
                data-testid="pos-close-kot"
                onClick={() => setKitchenTicket(null)}
                className="rounded-lg bg-black py-2 font-bold text-white"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bill / receipt */}
      {receiptSession && receiptBill && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Bill"
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/80 p-4"
        >
          <div className="pos-receipt my-auto w-full max-w-xs rounded-2xl bg-white p-5 font-mono text-[11px] text-black">
            <div className="text-center">
              <div className="text-sm font-black">{receiptSession.outletName}</div>
              <div>{receiptSession.status === "SETTLED" ? "BILL · PAID" : "BILL"}</div>
              <div>
                Table {receiptSession.tableId} · {receiptSession.guestCount} guests
              </div>
              <div>Server: {receiptSession.serverName}</div>
              <div>{new Date(receiptSession.openedAt).toLocaleString()}</div>
            </div>

            <hr className="my-2 border-dashed border-black/40" />

            <table className="w-full">
              <thead>
                <tr className="text-left">
                  <th className="font-bold">Item</th>
                  <th className="w-8 text-center font-bold">Qty</th>
                  <th className="w-16 text-right font-bold">Amount</th>
                </tr>
              </thead>
              <tbody>
                {receiptSession.lines.map((line) => (
                  <tr key={line.lineId}>
                    <td className="pr-1 align-top">{line.name}</td>
                    <td className="text-center align-top">{line.quantity}</td>
                    <td className="text-right align-top">
                      {formatMoney(line.unitPrice * line.quantity)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <hr className="my-2 border-dashed border-black/40" />

            <div className="space-y-0.5">
              <div className="flex justify-between">
                <span>Subtotal</span>
                <span>{formatMoney(receiptBill.subtotal)}</span>
              </div>
              {receiptBill.discountAmount > 0 && (
                <div className="flex justify-between">
                  <span>Discount ({receiptSession.discountPercent}%)</span>
                  <span>−{formatMoney(receiptBill.discountAmount)}</span>
                </div>
              )}
              {receiptBill.serviceCharge > 0 && (
                <div className="flex justify-between">
                  <span>Service ({receiptSession.serviceChargePercent}%)</span>
                  <span>{formatMoney(receiptBill.serviceCharge)}</span>
                </div>
              )}
              {receiptBill.cgstRateBps + receiptBill.sgstRateBps > 0 && (
                <>
                  <div className="flex justify-between">
                    <span>CGST {receiptBill.cgstRateBps / 100}%</span>
                    <span>{formatMoney(receiptBill.cgst)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>SGST {receiptBill.sgstRateBps / 100}%</span>
                    <span>{formatMoney(receiptBill.sgst)}</span>
                  </div>
                </>
              )}
              <div className="flex justify-between">
                <span>Round off</span>
                <span>{formatMoney(receiptBill.roundOff)}</span>
              </div>
              <div className="flex justify-between border-t border-black/40 pt-1 text-sm font-black">
                <span>TOTAL</span>
                <span>₹{receiptBill.grandTotal}</span>
              </div>
              <div className="flex justify-between">
                <span>Per guest</span>
                <span>₹{receiptBill.perGuest}</span>
              </div>
            </div>

            {receiptSession.payment && (
              <>
                <hr className="my-2 border-dashed border-black/40" />
                <div className="space-y-0.5">
                  <div className="flex justify-between">
                    <span>Paid by</span>
                    <span>{receiptSession.payment.method}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Tendered</span>
                    <span>₹{receiptSession.payment.amountTendered}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Change</span>
                    <span>₹{receiptSession.payment.changeDue}</span>
                  </div>
                </div>
              </>
            )}

            <p className="mt-3 text-center">Thank you! Please visit again.</p>
            {receiptSession.status === "SETTLED" && claimCodes[receiptSession.sessionId] && (
              <div className="mt-3 border-t border-dashed border-black/40 pt-2 text-center">
                <div className="text-[9px] uppercase tracking-wide">Add this bill to your Krave account</div>
                <div
                  data-testid="pos-receipt-claim-code"
                  className="text-base font-black tracking-[0.2em]"
                >
                  {claimCodes[receiptSession.sessionId]}
                </div>
                <div className="text-[9px]">Enter it under Your Orders. Valid for 30 days.</div>
              </div>
            )}
            {receiptBill.taxTotal > 0 && (
              <p className="mt-1 text-center text-[9px]">
                Not a GST tax invoice: no GSTIN is on record for this restaurant.
              </p>
            )}

            <div className="pos-no-print mt-4 space-y-2">
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
                  <div key={guest.seat} className="flex gap-1.5">
                    <div className="min-w-0 flex-1">
                      <BillSmsLink
                        phone={guest.phone}
                        testId={`pos-receipt-sms-${guest.seat}`}
                        label={`SMS ${guest.name || displayMobile(guest.phone)}`}
                        text={billSmsText({
                          outletName: receiptSession.outletName,
                          tableId: receiptSession.tableId,
                          guestName: guest.name,
                          total: receiptBill.grandTotal,
                          guestCount: receiptSession.guestCount,
                          share: null,
                          paid: receiptSession.status === "SETTLED",
                        })}
                      />
                    </div>
                    <button
                      type="button"
                      data-testid={`pos-receipt-edit-${guest.seat}`}
                      aria-label={`Edit ${guest.name || "guest"}'s number`}
                      onClick={() => setEditingGuest(`${receiptSession.sessionId}:${guest.seat}`)}
                      className="flex min-h-11 items-center gap-1 rounded-xl border border-black/20 px-3 font-sans text-xs font-bold"
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      Edit
                    </button>
                  </div>
                )
              )}
              {receiptSmsGuests.length === 0 &&
                (editingGuest === `${receiptSession.sessionId}:1` ? (
                  <GuestContactEditor
                    seat={1}
                    guest={receiptSession.guests.find((guest) => guest.seat === 1)}
                    tone="light"
                    onSave={(input) => saveGuest(receiptSession.sessionId, 1, input)}
                    onDone={() => setEditingGuest(null)}
                  />
                ) : (
                  <button
                    type="button"
                    data-testid="pos-receipt-add-guest"
                    onClick={() => setEditingGuest(`${receiptSession.sessionId}:1`)}
                    className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-black/30 font-sans text-xs font-bold"
                  >
                    <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                    Add a mobile number to text this bill
                  </button>
                ))}
            </div>

            <div className="pos-no-print mt-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => window.print()}
                className="flex items-center justify-center gap-1 rounded-lg border border-black/20 py-2 font-bold"
              >
                <Printer className="h-3.5 w-3.5" /> Print
              </button>
              <button
                type="button"
                data-testid="pos-close-receipt"
                onClick={() => setReceiptSessionId(null)}
                className="flex items-center justify-center gap-1 rounded-lg bg-black py-2 font-bold text-white"
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Interactive Guest Bill Splitter Modal */}
      {splitModalOpen && activeSession && bill && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Split bill by guest"
          className="pos-no-print fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 overflow-y-auto"
        >
          <div className="my-auto w-full max-w-xl space-y-4 rounded-2xl border border-white/15 bg-[#121721] p-5">
            <div className="flex items-center justify-between">
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
                className="rounded-lg p-1 hover:bg-white/10"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-56 space-y-2 overflow-y-auto pr-1">
              {activeSession.lines.map((line) => (
                <div
                  key={line.lineId}
                  className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-[#0E131D] p-2.5 text-xs"
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
                    className="rounded-lg border border-white/15 bg-[#121721] px-2.5 py-1.5 text-xs font-bold"
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

            <div className="flex justify-between border-t border-white/10 pt-3">
              <button
                type="button"
                onClick={() => setLineAssignments({})}
                className="rounded-xl border border-white/15 px-3 py-2 text-xs font-bold"
              >
                Reset to Equal Split
              </button>
              <button
                type="button"
                data-testid="pos-close-split"
                onClick={() => setSplitModalOpen(false)}
                className="rounded-xl bg-emerald-500 px-4 py-2 text-xs font-black"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Settled Shift Bills Drawer */}
      {settledDrawerOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Settled shift bills"
          className="pos-no-print fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <div className="w-full max-w-lg space-y-4 rounded-2xl border border-white/15 bg-[#121721] p-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-black">Settled Bills & Shift Summary</h2>
                <p className="text-xs opacity-65">
                  {shift.settledBills} bills · ₹{formatMoney(shift.grossSales)} total · Tax ₹
                  {formatMoney(shift.taxCollected)}
                </p>
              </div>
              <button
                type="button"
                aria-label="Close settled bills"
                onClick={() => setSettledDrawerOpen(false)}
                className="rounded-lg p-1 hover:bg-white/10"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center text-xs">
              {(["CASH", "CARD", "UPI"] as const).map((method) => (
                <div key={method} className="rounded-xl border border-white/10 bg-[#0E131D] p-2.5">
                  <div className="text-[10px] opacity-60">{method}</div>
                  <div className="font-black text-emerald-400">
                    ₹{formatMoney(shift.byPaymentMethod[method])}
                  </div>
                </div>
              ))}
            </div>

            <ul className="max-h-64 divide-y divide-white/10 overflow-y-auto text-xs">
              {settledSessions.length === 0 && (
                <li className="py-4 text-center opacity-60">No settled bills in this shift yet.</li>
              )}
              {settledSessions.map((settled) => {
                const settledBill = calculatePosBill(settled);
                return (
                  <li
                    key={settled.sessionId}
                    className="flex items-center justify-between py-2.5"
                  >
                    <div>
                      <div className="font-bold">
                        Table {settled.tableId} · ₹{settledBill.grandTotal} ({settled.payment?.method})
                      </div>
                      <div className="text-[11px] opacity-60">
                        {settled.guestCount} guests · Server: {settled.serverName}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setSettledDrawerOpen(false);
                        setReceiptSessionId(settled.sessionId);
                      }}
                      className="rounded-lg border border-white/15 px-2.5 py-1.5 font-bold hover:bg-white/5"
                    >
                      View Invoice
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}

      {/* Shift open / cash-up */}
      {shiftFormOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={activeShift ? "Close shift" : "Open shift"}
          className="pos-no-print fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
        >
          <form
            onSubmit={activeShift ? handleCloseShift : handleOpenShift}
            className="w-full max-w-sm space-y-4 rounded-2xl border border-white/15 bg-[#121721] p-5"
          >
            <div className="flex items-center justify-between">
              <h2 className="text-base font-black">
                {activeShift ? "Close shift & count cash" : "Open shift"}
              </h2>
              <button
                type="button"
                aria-label="Cancel"
                onClick={() => setShiftFormOpen(false)}
                className="rounded-lg p-1 hover:bg-white/10"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <label className="block space-y-1 text-xs">
              <span className="opacity-70">Cashier</span>
              <input
                type="text"
                required
                value={cashierName}
                onChange={(event) => setCashierName(event.target.value)}
                className="w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 py-2"
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
                    min={0}
                    required
                    value={countedCash}
                    onChange={(event) => setCountedCash(event.target.value)}
                    className="w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 py-2 text-base font-black"
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
                  min={0}
                  required
                  value={openingCash}
                  onChange={(event) => setOpeningCash(event.target.value)}
                  className="w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 py-2 text-base font-black"
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
              className="w-full rounded-xl bg-emerald-500 py-2.5 text-xs font-black"
            >
              {activeShift ? "Close Shift & Print Z-Report" : "Open Shift"}
            </button>
          </form>
        </div>
      )}

      {/* Z-report */}
      {zReport && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Z report"
          className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/80 p-4"
        >
          <div
            data-testid="pos-z-report"
            className="pos-receipt my-auto w-full max-w-xs rounded-2xl bg-white p-5 font-mono text-[11px] text-black"
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
                className="flex items-center justify-center gap-1 rounded-lg border border-black/20 py-2 font-bold"
              >
                <Printer className="h-3.5 w-3.5" /> Print
              </button>
              <button
                type="button"
                data-testid="pos-close-z-report"
                onClick={() => setZReport(null)}
                className="flex items-center justify-center gap-1 rounded-lg bg-black py-2 font-bold text-white"
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> Close
              </button>
            </div>
          </div>
        </div>
      )}

      <footer className="pos-no-print mx-auto max-w-[1600px] px-4 pb-8 text-[11px] opacity-50">
        <Leaf className="mr-1 inline h-3 w-3" />
        Offline terminal. Tables, bills and shift totals stay on this device until you clear them.
      </footer>
    </div>
  );
}
