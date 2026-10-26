"use client";

import React, { useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import { CalendarDays, Printer, RotateCw, Search, X } from "lucide-react";
import { billSmsText } from "@/lib/pos/billSms";
import {
  calculatePosBill,
  restorePosSessions,
  type PosPaymentMethod,
  type PosTableSession,
} from "@/lib/pos/posEngine";
import { PosReceiptPaper } from "./PosReceiptPaper";
import { SendBill } from "./SendBill";
import { displayMobile } from "./PosGuestCard";
import { BillEmailAndPdf, SendToNumber, useBillLink } from "./PosBillShare";
import { FULL_SCREEN_DIALOG, OverlayDialog } from "../OverlayDialog";
import { POS_PAPER_DIALOG } from "./posDialog";

type Preset = "today" | "yesterday" | "week" | "month" | "day";

interface Entry {
  session: PosTableSession;
  billNumber: number | null;
  grandTotal: number;
  claimCode: string | null;
}

interface Summary {
  bills: number;
  total: number;
  byMethod: Record<PosPaymentMethod, number>;
}

const PRESETS: { id: Exclude<Preset, "day">; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "Last 7 days" },
  { id: "month", label: "This month" },
];

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

/** Periods are in the phone's own time, so "Today" means today at the restaurant. */
function periodOf(preset: Preset, day: string): { from: Date; to: Date } {
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);
  switch (preset) {
    case "yesterday":
      return { from: addDays(today, -1), to: today };
    case "week":
      return { from: addDays(today, -6), to: tomorrow };
    case "month":
      return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: tomorrow };
    case "day": {
      const [year, month, date] = day.split("-").map(Number);
      const from = year && month && date ? new Date(year, month - 1, date) : today;
      return { from, to: addDays(from, 1) };
    }
    default:
      return { from: today, to: tomorrow };
  }
}

function toInputDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function rupees(value: number): string {
  return `₹${value.toLocaleString("en-IN")}`;
}

function parseEntries(raw: unknown): Entry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): Entry[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const [session] = restorePosSessions(JSON.stringify([record.session]));
    if (!session) return [];
    return [
      {
        session,
        billNumber: typeof record.billNumber === "number" ? record.billNumber : null,
        grandTotal: calculatePosBill(session).grandTotal,
        claimCode: typeof record.claimCode === "string" ? record.claimCode : null,
      },
    ];
  });
}

function summarise(entries: Entry[]): Summary {
  const byMethod: Record<PosPaymentMethod, number> = { CASH: 0, CARD: 0, UPI: 0 };
  for (const entry of entries) {
    if (entry.session.payment) byMethod[entry.session.payment.method] += entry.grandTotal;
  }
  return {
    bills: entries.length,
    total: entries.reduce((sum, entry) => sum + entry.grandTotal, 0),
    byMethod,
  };
}

function matches(entry: Entry, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const { session } = entry;
  return (
    String(entry.billNumber ?? "") === needle ||
    String(entry.grandTotal) === needle ||
    session.tableId.toLowerCase() === needle ||
    session.serverName.toLowerCase().includes(needle) ||
    session.guests.some(
      (guest) =>
        guest.name.toLowerCase().includes(needle) ||
        (/^\d{4,}$/.test(needle) && (guest.phone ?? "").includes(needle))
    )
  );
}

/** A waiter's search must name one bill; anything vaguer would list the restaurant's takings. */
function isBillLookup(query: string): boolean {
  const digits = query.replace(/\D/g, "");
  return digits.length >= 10 || /^\d{1,9}$/.test(query);
}

/**
 * Every paid bill of the restaurant, by day, from all of its terminals: totals for the
 * period, search by guest, mobile, table, bill number or amount, and any bill reopened as a
 * receipt to print or text again. Offline it falls back to the bills saved on this phone.
 *
 * A waiter (`seesAllSales` false) gets the same screen as a one-bill lookup: no list and no
 * totals until they type a bill number or the guest's mobile number.
 */
export function PosSalesHistory({
  outletId,
  outletName,
  seesAllSales,
  mailEnabled,
  localSessions,
  onClose,
}: {
  outletId: number;
  outletName: string;
  /** False for a waiter: one bill at a time, found by number or mobile. */
  seesAllSales: boolean;
  mailEnabled: boolean;
  /** This device's bills, shown when the server cannot be reached. */
  localSessions: PosTableSession[];
  onClose: () => void;
}) {
  const [preset, setPreset] = useState<Preset>("today");
  const [day, setDay] = useState(() => toInputDate(new Date()));
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "offline" | "error">("loading");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [selected, setSelected] = useState<Entry | null>(null);
  const moreController = useRef<AbortController | null>(null);

  const period = useMemo(() => periodOf(preset, day), [preset, day]);
  const savedOnThisPhone = useEffectEvent((query: string): Entry[] =>
    localSessions
      .filter((session) => {
        const paidAt = Date.parse(session.payment?.settledAt ?? "");
        return (
          session.status === "SETTLED" &&
          session.outletId === outletId &&
          paidAt >= period.from.getTime() &&
          paidAt < period.to.getTime()
        );
      })
      .map((session) => ({
        session,
        billNumber: null,
        grandTotal: calculatePosBill(session).grandTotal,
        claimCode: null,
      }))
      .filter((entry) => matches(entry, query))
      .sort((a, b) =>
        (b.session.payment?.settledAt ?? "").localeCompare(a.session.payment?.settledAt ?? "")
      )
  );

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 300);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    moreController.current?.abort();
    const controller = new AbortController();
    if (!seesAllSales && !isBillLookup(debouncedQuery)) {
      setEntries([]);
      setSummary(null);
      setNextCursor(null);
      setStatus("ready");
      setErrorText(null);
      return () => controller.abort();
    }
    setStatus("loading");
    setErrorText(null);
    const params = new URLSearchParams({
      outletId: String(outletId),
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      q: debouncedQuery,
    });
    fetch(`/api/pos/history?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(result?.message ?? "Could not load sales.");
        setEntries(parseEntries(result.entries));
        setSummary(result.summary ?? null);
        setNextCursor(typeof result.nextCursor === "string" ? result.nextCursor : null);
        setStatus("ready");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        if (error instanceof TypeError) {
          // No network: show what this phone has, so a guest can still get their bill.
          // A waiter's phone keeps only their own bills, and gets no totals.
          const local = savedOnThisPhone(debouncedQuery);
          setEntries(local);
          setSummary(seesAllSales ? summarise(local) : null);
          setNextCursor(null);
          setStatus("offline");
          return;
        }
        setStatus("error");
        setErrorText(error instanceof Error ? error.message : "Could not load sales.");
      });
    return () => controller.abort();
  }, [outletId, period, debouncedQuery, reloadKey, seesAllSales]);

  function loadMore() {
    if (!nextCursor) return;
    const controller = new AbortController();
    moreController.current = controller;
    setLoadingMore(true);
    const params = new URLSearchParams({
      outletId: String(outletId),
      from: period.from.toISOString(),
      to: period.to.toISOString(),
      q: debouncedQuery,
      before: nextCursor,
    });
    fetch(`/api/pos/history?${params}`, { signal: controller.signal })
      .then(async (response) => {
        const result = await response.json().catch(() => null);
        if (!response.ok) throw new Error(result?.message ?? "Could not load more bills.");
        setEntries((current) => [...current, ...parseEntries(result.entries)]);
        setNextCursor(typeof result.nextCursor === "string" ? result.nextCursor : null);
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setErrorText(error instanceof Error ? error.message : "Could not load more bills.");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoadingMore(false);
      });
  }

  const days = useMemo(() => {
    const groups = new Map<string, { label: string; entries: Entry[]; total: number }>();
    const today = toInputDate(new Date());
    const yesterday = toInputDate(addDays(new Date(), -1));
    for (const entry of entries) {
      const paidAt = new Date(entry.session.payment?.settledAt ?? entry.session.openedAt);
      const key = toInputDate(paidAt);
      const name = paidAt.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
      const label = key === today ? `Today · ${name}` : key === yesterday ? `Yesterday · ${name}` : name;
      const group = groups.get(key) ?? { label, entries: [], total: 0 };
      group.entries.push(entry);
      group.total += entry.grandTotal;
      groups.set(key, group);
    }
    return [...groups.values()];
  }, [entries]);

  const chip = (active: boolean) =>
    `min-h-10 shrink-0 whitespace-nowrap rounded-xl border px-3 text-xs font-bold ${
      active ? "border-emerald-400 bg-emerald-500/20 text-emerald-200" : "border-white/10 bg-[#121721]"
    }`;

  return (
    <>
      <OverlayDialog
        isOpen
        onClose={onClose}
        label={seesAllSales ? "Sales history" : "Find a bill"}
        className={`${FULL_SCREEN_DIALOG} pos-no-print bg-[#0A0D12] text-white`}
        closeOnBackdrop={false}
      >
        <div className="mx-auto max-w-3xl space-y-4 p-4 pb-16">
          <div className="sticky top-0 z-10 -mx-4 space-y-3 border-b border-white/10 bg-[#0A0D12]/95 px-4 pb-3 pt-1 backdrop-blur">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-lg font-black">{seesAllSales ? "Sales" : "Find a bill"}</h2>
                <p className="text-xs opacity-60">
                  {outletName} · {seesAllSales ? "every paid bill" : "search the bill number or mobile"}
                </p>
              </div>
              <button
                type="button"
                aria-label={seesAllSales ? "Close sales" : "Close"}
                onClick={onClose}
                className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-white/10 hover:bg-white/5"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
              {PRESETS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  aria-pressed={preset === option.id}
                  data-testid={`sales-range-${option.id}`}
                  onClick={() => setPreset(option.id)}
                  className={chip(preset === option.id)}
                >
                  {option.label}
                </button>
              ))}
              <label className={`${chip(preset === "day")} flex items-center gap-1.5`}>
                <CalendarDays className="h-4 w-4" aria-hidden="true" />
                <span className="sr-only">Pick a date</span>
                <input
                  type="date"
                  data-testid="sales-range-day"
                  value={day}
                  max={toInputDate(new Date())}
                  onChange={(event) => {
                    if (!event.target.value) return;
                    setDay(event.target.value);
                    setPreset("day");
                  }}
                  className="bg-transparent text-xs font-bold outline-none [color-scheme:dark]"
                />
              </label>
            </div>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 opacity-50" />
              <input
                type="search"
                aria-label="Search bills"
                data-testid="sales-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search name, mobile, table, bill no. or amount"
                className="min-h-11 w-full rounded-xl border border-white/15 bg-[#121721] py-2 pl-9 pr-3 text-sm outline-none focus:border-emerald-400/60"
              />
            </div>
          </div>

          {summary && (
            <div data-testid="sales-summary" className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              <div className="col-span-3 flex items-baseline justify-between rounded-2xl border border-emerald-400/30 bg-emerald-500/10 p-3 sm:col-span-1 sm:block">
                <div>
                  <div className="text-[11px] opacity-70">Total sales</div>
                  <div className="text-xl font-black text-emerald-300">{rupees(summary.total)}</div>
                </div>
                <div className="text-sm font-bold opacity-80 sm:hidden">
                  {summary.bills} bill{summary.bills === 1 ? "" : "s"}
                </div>
              </div>
              <div className="hidden rounded-2xl border border-white/10 bg-[#121721] p-3 sm:block">
                <div className="text-[11px] opacity-70">Bills</div>
                <div className="text-lg font-black">{summary.bills}</div>
              </div>
              {(["CASH", "UPI", "CARD"] as const).map((method) => (
                <div key={method} className="rounded-2xl border border-white/10 bg-[#121721] p-3">
                  <div className="text-[11px] opacity-70">{method === "CASH" ? "Cash" : method === "UPI" ? "UPI" : "Card"}</div>
                  <div className="text-base font-black sm:text-lg">{rupees(summary.byMethod[method])}</div>
                </div>
              ))}
            </div>
          )}

          {status === "offline" && (
            <p role="status" className="rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              No connection. Showing the bills saved on this phone; other phones&apos; bills appear
              when you are back online.
            </p>
          )}
          {status === "error" && (
            <div role="alert" className="flex items-center justify-between gap-3 rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
              <span>{errorText}</span>
              <button
                type="button"
                onClick={() => setReloadKey((key) => key + 1)}
                className="flex min-h-10 items-center gap-1 rounded-lg border border-rose-300/30 px-3 font-bold"
              >
                <RotateCw className="h-3.5 w-3.5" /> Try again
              </button>
            </div>
          )}

          {status === "loading" && entries.length === 0 && (
            <div className="space-y-2" aria-hidden="true">
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-16 animate-pulse rounded-2xl bg-white/5" />
              ))}
            </div>
          )}

          {status !== "loading" && status !== "error" && entries.length === 0 && (
            <p
              data-testid="sales-empty"
              className="rounded-2xl border border-dashed border-white/15 p-6 text-center text-sm opacity-70"
            >
              {!seesAllSales && !isBillLookup(debouncedQuery)
                ? "Type the bill number of a bill you took, or the 10-digit mobile number the bill was sent to."
                : debouncedQuery
                ? `No bills match “${debouncedQuery}” in this period.`
                : "No bills in this period."}
            </p>
          )}

          <div className={`space-y-5 ${status === "loading" && entries.length > 0 ? "opacity-60" : ""}`}>
            {days.map((group) => (
              <section key={group.label} className="space-y-2">
                <div className="flex items-baseline justify-between text-xs">
                  <h3 className="font-black uppercase tracking-wider text-white/60">{group.label}</h3>
                  <span className="opacity-60">
                    {group.entries.length} bill{group.entries.length === 1 ? "" : "s"} · {rupees(group.total)}
                  </span>
                </div>
                <ul className="space-y-2">
                  {group.entries.map((entry) => {
                    const { session } = entry;
                    const lead = session.guests.find((guest) => guest.name || guest.phone);
                    const items = session.lines.map((line) => line.name);
                    const paidAt = new Date(session.payment?.settledAt ?? session.openedAt);
                    return (
                      <li key={session.sessionId}>
                        <button
                          type="button"
                          data-testid="sales-entry"
                          onClick={() => setSelected(entry)}
                          className="flex w-full items-center gap-3 rounded-2xl border border-white/10 bg-[#121721] p-3 text-left transition hover:border-emerald-400/50 active:scale-[0.99]"
                        >
                          <div className="w-14 shrink-0 text-center">
                            <div className="text-sm font-black">
                              {entry.billNumber !== null ? `#${entry.billNumber}` : "—"}
                            </div>
                            <div className="text-[11px] opacity-60">
                              {paidAt.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" })}
                            </div>
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-bold">
                              {session.tableId}
                              {lead ? ` · ${lead.name || displayMobile(lead.phone ?? "")}` : ""}
                              <span className="font-normal opacity-60"> · {session.guestCount} guests</span>
                            </div>
                            <div className="truncate text-[11px] opacity-60">
                              {items.slice(0, 2).join(", ")}
                              {items.length > 2 ? ` +${items.length - 2} more` : ""}
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="text-base font-black text-emerald-300">{rupees(entry.grandTotal)}</div>
                            <div className="text-[10px] font-bold opacity-70">
                              {session.payment?.method}
                              {session.corrections.length > 0 ? " · corrected" : ""}
                            </div>
                          </div>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>

          {nextCursor && (
            <button
              type="button"
              data-testid="sales-load-more"
              onClick={loadMore}
              disabled={loadingMore}
              className="min-h-11 w-full rounded-xl border border-white/15 text-sm font-bold disabled:opacity-50"
            >
              {loadingMore ? "Loading…" : "Show older bills"}
            </button>
          )}
        </div>
      </OverlayDialog>

      {selected && (
        <SalesReceipt entry={selected} mailEnabled={mailEnabled} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

/** A past bill, as printed, with print and send again. */
function SalesReceipt({
  entry,
  mailEnabled,
  onClose,
}: {
  entry: Entry;
  mailEnabled: boolean;
  onClose: () => void;
}) {
  const { session } = entry;
  const bill = calculatePosBill(session);
  // Sales history is only reachable signed in, so the link can always be made.
  const link = useBillLink(session.sessionId, true);
  const guestsWithPhones = session.guests.flatMap((guest) =>
    guest.phone ? [{ seat: guest.seat, name: guest.name, phone: guest.phone }] : []
  );
  const textFor = (guestName: string) =>
    billSmsText({
      outletName: session.outletName,
      tableId: session.tableId,
      guestName,
      total: bill.grandTotal,
      guestCount: session.guestCount,
      share: null,
      paid: session.status === "SETTLED",
      link,
    });

  return (
    <OverlayDialog isOpen onClose={onClose} label="Past bill" className={POS_PAPER_DIALOG}>
      <div className="pos-receipt rounded-2xl bg-white p-5 font-mono text-[11px] text-black">
        <PosReceiptPaper session={session} bill={bill} billNumber={entry.billNumber} claimCode={entry.claimCode} />

        <div className="pos-no-print mt-4 space-y-2 font-sans">
          {guestsWithPhones.map((guest) => (
            <div key={guest.seat} className="space-y-1.5 rounded-xl border border-black/10 p-2">
              <div className="text-xs">
                <strong>{guest.name || "Guest"}</strong> · {displayMobile(guest.phone)}
              </div>
              <SendBill
                phone={guest.phone}
                text={textFor(guest.name)}
                label={`SMS ${rupees(bill.grandTotal)}`}
                testId={`sales-receipt-sms-${guest.seat}`}
              />
            </div>
          ))}
          <SendToNumber
            text={textFor("")}
            label={`SMS ${rupees(bill.grandTotal)}`}
            testId="sales-receipt-sms-other"
            numberTestId="sales-receipt-number"
          />
          <BillEmailAndPdf
            sessionId={session.sessionId}
            link={link}
            signedIn
            mailEnabled={mailEnabled}
            testId="sales-receipt"
          />
        </div>

        <div className="pos-no-print mt-4 grid grid-cols-2 gap-2 font-sans">
          <button
            type="button"
            onClick={() => window.print()}
            className="flex min-h-11 items-center justify-center gap-1 rounded-lg border border-black/20 font-bold"
          >
            <Printer className="h-3.5 w-3.5" /> Print
          </button>
          <button
            type="button"
            data-testid="sales-receipt-close"
            onClick={onClose}
            className="min-h-11 rounded-lg bg-black font-bold text-white"
          >
            Close
          </button>
        </div>
      </div>
    </OverlayDialog>
  );
}
