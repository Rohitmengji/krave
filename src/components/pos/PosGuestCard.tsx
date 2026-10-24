"use client";

import React, { useState } from "react";
import { billSmsText } from "@/lib/pos/billSms";
import { SendBill } from "./SendBill";
import { normalizeIndianMobile, type PosGuest, type PosGuestSplitShare } from "@/lib/pos/posEngine";

function formatMoney(value: number): string {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** How a saved number reads back to staff: the ten digits, grouped the way people say them. */
export function displayMobile(phone: string): string {
  const digits = phone.replace(/^\+91/, "");
  return `${digits.slice(0, 5)} ${digits.slice(5)}`;
}

/**
 * Add or correct one guest's name and mobile, wherever the guest is shown. Clearing both
 * fields and saving removes the guest.
 */
export function GuestContactEditor({
  seat,
  guest,
  tone,
  onSave,
  onDone,
}: {
  seat: number;
  guest: PosGuest | undefined;
  /** The receipt is printed black on white; the rest of the terminal is dark. */
  tone: "dark" | "light";
  /** Returns an error message, or null once saved. */
  onSave: (input: { name: string; phone: string }) => string | null;
  onDone: () => void;
}) {
  const [name, setName] = useState(guest?.name ?? "");
  const [phone, setPhone] = useState(guest?.phone ? displayMobile(guest.phone) : "");
  const [error, setError] = useState<string | null>(null);
  const field =
    tone === "dark"
      ? "border-white/15 bg-[#0E131D] text-white"
      : "border-black/30 bg-white text-black";

  return (
    <form
      data-testid={`pos-guest-editor-${seat}`}
      className="space-y-1.5 font-sans"
      onSubmit={(event) => {
        event.preventDefault();
        const problem = onSave({ name, phone });
        setError(problem);
        if (!problem) onDone();
      }}
    >
      <div className="grid grid-cols-2 gap-1.5">
        <input
          type="text"
          aria-label={`Guest ${seat} name`}
          data-testid="pos-guest-edit-name"
          value={name}
          maxLength={40}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
          placeholder="Name"
          className={`min-h-11 w-full rounded-lg border px-2.5 text-sm ${field}`}
        />
        <input
          type="tel"
          inputMode="tel"
          aria-label={`Guest ${seat} mobile number`}
          data-testid="pos-guest-edit-phone"
          value={phone}
          maxLength={16}
          autoComplete="off"
          // Opening the editor to fix a number should put the cursor straight on it.
          autoFocus
          onChange={(event) => setPhone(event.target.value)}
          placeholder="Mobile (10 digits)"
          className={`min-h-11 w-full rounded-lg border px-2.5 text-sm ${field}`}
        />
      </div>
      {error && (
        <p role="alert" className={`text-xs ${tone === "dark" ? "text-rose-400" : "text-red-700"}`}>
          {error}
        </p>
      )}
      <div className="grid grid-cols-2 gap-1.5">
        <button
          type="button"
          data-testid="pos-guest-edit-cancel"
          onClick={onDone}
          className={`min-h-11 rounded-lg border text-xs font-bold ${
            tone === "dark" ? "border-white/15" : "border-black/30"
          }`}
        >
          Cancel
        </button>
        <button
          type="submit"
          data-testid="pos-guest-edit-save"
          className="min-h-11 rounded-lg bg-emerald-600 text-xs font-black text-white"
        >
          Save
        </button>
      </div>
    </form>
  );
}

/**
 * One guest's part of a split bill, with their name and mobile number. Edits stay in this card
 * until saved, so a half-typed number never reaches the table.
 */
export function PosGuestCard({
  share,
  guest,
  outletName,
  tableId,
  guestCount,
  total,
  onSave,
}: {
  share: PosGuestSplitShare;
  guest: PosGuest | undefined;
  outletName: string;
  tableId: string;
  guestCount: number;
  total: number;
  /** Returns an error message, or null once saved. */
  onSave: (input: { name: string; phone: string }) => string | null;
}) {
  const [name, setName] = useState(guest?.name ?? "");
  const [phone, setPhone] = useState(guest?.phone ? displayMobile(guest.phone) : "");
  const [error, setError] = useState<string | null>(null);
  const saved = {
    name: guest?.name ?? "",
    phone: guest?.phone ? displayMobile(guest.phone) : "",
  };
  const dirty = name.trim() !== saved.name || phone.trim() !== saved.phone;
  const seat = share.guestIndex;

  return (
    <div
      data-testid={`pos-split-guest-${seat}`}
      className="space-y-2 rounded-xl border border-emerald-400/30 bg-[#0E131D] p-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        <div className="truncate text-xs font-bold opacity-75">{share.guestLabel}</div>
        <div className="text-lg font-black text-emerald-400">₹{share.payableAmount}</div>
      </div>
      <div className="text-[10px] opacity-60">
        Food ₹{formatMoney(share.itemsSubtotal)} · Tax/Adj{" "}
        {share.taxAndChargesShare >= 0 ? "+" : ""}₹{formatMoney(share.taxAndChargesShare)}
      </div>

      <form
        className="space-y-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const problem = onSave({ name, phone });
          setError(problem);
          if (problem) return;
          const normalized = normalizeIndianMobile(phone);
          setName(name.trim().replace(/\s+/g, " "));
          setPhone(normalized ? displayMobile(normalized) : "");
        }}
      >
        <input
          type="text"
          aria-label={`Guest ${seat} name`}
          data-testid={`pos-guest-name-${seat}`}
          value={name}
          maxLength={40}
          autoComplete="off"
          onChange={(event) => setName(event.target.value)}
          placeholder="Name"
          className="w-full rounded-lg border border-white/15 bg-[#121721] px-2.5 py-2 text-xs"
        />
        <input
          type="tel"
          inputMode="tel"
          aria-label={`Guest ${seat} mobile number`}
          data-testid={`pos-guest-phone-${seat}`}
          value={phone}
          maxLength={16}
          autoComplete="off"
          onChange={(event) => setPhone(event.target.value)}
          placeholder="Mobile (10 digits)"
          className="w-full rounded-lg border border-white/15 bg-[#121721] px-2.5 py-2 text-xs"
        />
        {error && (
          <p role="alert" className="text-[11px] text-rose-400">
            {error}
          </p>
        )}
        {dirty && (
          <button
            type="submit"
            data-testid={`pos-guest-save-${seat}`}
            className="min-h-11 w-full rounded-lg border border-emerald-400/50 py-2 text-xs font-black text-emerald-300"
          >
            Save guest
          </button>
        )}
      </form>

      {guest?.phone && !dirty && (
        <SendBill
          phone={guest.phone}
          testId={`pos-guest-sms-${seat}`}
          label={`SMS ₹${share.payableAmount}`}
          text={billSmsText({
            outletName,
            tableId,
            guestName: guest.name,
            total,
            guestCount,
            share: share.payableAmount,
            paid: false,
          })}
        />
      )}
    </div>
  );
}
