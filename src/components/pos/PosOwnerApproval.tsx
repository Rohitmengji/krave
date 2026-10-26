"use client";

import React, { useState } from "react";
import { Lock, X } from "lucide-react";
import type { PosPaymentMethod } from "@/lib/pos/posEngine";
import { OverlayDialog } from "../OverlayDialog";
import { POS_CLOSE_BUTTON, POS_FORM_DIALOG } from "./posDialog";

export type OwnerCorrection =
  | { kind: "payment"; method: PosPaymentMethod; reason: string }
  | { kind: "reopen"; reason: string };

const METHODS: PosPaymentMethod[] = ["CASH", "UPI", "CARD"];

/**
 * Owner approval for changing a paid bill: what to change, why, and the owner's PIN. The PIN
 * is checked by the server, so this needs a connection; the change is made only once it passes.
 */
export function PosOwnerApproval({
  kind,
  outletId,
  tableId,
  total,
  currentMethod,
  onApply,
  onClose,
}: {
  kind: "payment" | "reopen";
  outletId: number;
  tableId: string;
  total: number;
  currentMethod: PosPaymentMethod;
  /** Returns an error message, or null once the bill has been changed. */
  onApply: (correction: OwnerCorrection) => string | null;
  onClose: () => void;
}) {
  const [method, setMethod] = useState<PosPaymentMethod>(
    METHODS.find((candidate) => candidate !== currentMethod) ?? "UPI"
  );
  const [reason, setReason] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (kind === "reopen" && reason.trim().length < 3) {
      setError("Say why the bill is being reopened.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/pos/owner-pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ outletId, pin }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.message ?? "The PIN could not be checked.");
      const problem = onApply(
        kind === "payment" ? { kind, method, reason } : { kind, reason }
      );
      if (problem) setError(problem);
      else onClose();
    } catch (caught) {
      setError(
        caught instanceof TypeError || (caught instanceof DOMException && caught.name === "TimeoutError")
          ? "No connection. The owner PIN is checked online; try again when the phone has signal."
          : caught instanceof Error
          ? caught.message
          : "The PIN could not be checked."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <OverlayDialog
      isOpen
      onClose={onClose}
      // While the PIN is being checked, closing would let the answer change a bill nobody is looking at.
      onDismiss={busy ? () => {} : onClose}
      label={kind === "payment" ? "Change payment" : "Reopen bill"}
      className={POS_FORM_DIALOG}
      closeOnBackdrop={false}
    >
      <form
        onSubmit={submit}
        className="space-y-4 rounded-2xl border border-white/15 bg-[#121721] p-5 text-white"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="flex items-center gap-2 text-base font-black">
              <Lock className="h-4 w-4 text-amber-300" aria-hidden="true" />
              {kind === "payment" ? "Change payment" : "Reopen bill"}
            </h2>
            <p className="mt-1 text-xs opacity-70">
              Table {tableId} · ₹{total} · paid by {currentMethod}
            </p>
          </div>
          <button type="button" aria-label="Cancel" onClick={onClose} disabled={busy} className={`${POS_CLOSE_BUTTON} disabled:opacity-40`}>
            <X className="h-5 w-5" />
          </button>
        </div>

        {kind === "payment" ? (
          <fieldset className="space-y-1.5">
            <legend className="text-xs opacity-70">Actually paid by</legend>
            <div className="grid grid-cols-3 gap-2">
              {METHODS.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  data-testid={`pos-owner-method-${candidate}`}
                  disabled={candidate === currentMethod}
                  aria-pressed={method === candidate}
                  onClick={() => setMethod(candidate)}
                  className={`min-h-11 rounded-xl border text-xs font-black disabled:opacity-30 ${
                    method === candidate
                      ? "border-emerald-400 bg-emerald-500/20 text-emerald-200"
                      : "border-white/15"
                  }`}
                >
                  {candidate}
                </button>
              ))}
            </div>
          </fieldset>
        ) : (
          <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
            The table goes back on the floor so items can be added; settle it again when done.
          </p>
        )}

        <label className="block space-y-1 text-xs">
          <span className="opacity-70">
            Reason{kind === "payment" ? " (optional)" : ""}
          </span>
          <input
            type="text"
            data-testid="pos-owner-reason"
            maxLength={120}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder={kind === "payment" ? "e.g. Paid by GPay, marked cash" : "e.g. Guests ordered dessert"}
            className="min-h-11 w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 text-base"
          />
        </label>

        <label className="block space-y-1 text-xs">
          <span className="opacity-70">Owner PIN</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            data-testid="pos-owner-pin"
            maxLength={6}
            required
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
            className="min-h-11 w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 text-lg tracking-[0.4em]"
          />
        </label>

        {error && (
          <p role="alert" className="text-xs text-rose-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          data-testid="pos-owner-confirm"
          disabled={busy || pin.length < 4}
          className="min-h-11 w-full rounded-xl bg-emerald-500 text-sm font-black text-black disabled:opacity-40"
        >
          {busy ? "Checking…" : kind === "payment" ? `Change to ${method}` : "Reopen bill"}
        </button>
      </form>
    </OverlayDialog>
  );
}
