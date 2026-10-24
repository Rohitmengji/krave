"use client";

import React, { useEffect, useState } from "react";

/**
 * The PIN the owner types at the table terminal to approve changing a paid bill. Setting or
 * changing it asks for the account password, because the counter phone is signed in as the
 * owner and anyone holding it could otherwise set their own.
 */
export function PosPinSettings({ restaurantId }: { restaurantId: string }) {
  const [pinSet, setPinSet] = useState<boolean | null>(null);
  const [pin, setPin] = useState("");
  const [confirmPin, setConfirmPin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/owner/${restaurantId}/pos-pin`, { signal: controller.signal })
      .then((response) => (response.ok ? response.json() : null))
      .then((result) => {
        if (result) setPinSet(Boolean(result.pinSet));
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [restaurantId]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!/^\d{4,6}$/.test(pin)) {
      setMessage({ ok: false, text: "Choose a PIN of 4 to 6 digits." });
      return;
    }
    if (pin !== confirmPin) {
      setMessage({ ok: false, text: "The two PINs do not match." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/owner/${restaurantId}/pos-pin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({ pin, password }),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.message ?? "Could not save the PIN.");
      setPinSet(true);
      setPin("");
      setConfirmPin("");
      setPassword("");
      setMessage({ ok: true, text: "Owner PIN saved. Use it at the table terminal." });
    } catch (error) {
      setMessage({
        ok: false,
        text: error instanceof Error ? error.message : "Could not save the PIN.",
      });
    } finally {
      setBusy(false);
    }
  }

  const input =
    "w-full rounded-xl border border-white/15 bg-[#0a0d12] px-3 py-2 text-base tracking-widest";

  return (
    <section
      data-testid="pos-pin-settings"
      className="space-y-4 rounded-2xl border border-white/10 bg-[#121721] p-6"
    >
      <div>
        <h2 className="text-xl font-bold">Table POS owner PIN</h2>
        <p className="mt-1 text-sm text-slate-400">
          Needed at the table terminal to change how a paid bill was paid, or to reopen it.
          {pinSet === true ? " A PIN is set." : pinSet === false ? " No PIN is set yet." : ""}
        </p>
      </div>
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">{pinSet ? "New PIN" : "PIN"} (4–6 digits)</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={6}
            value={pin}
            onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))}
            className={input}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Type the PIN again</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            maxLength={6}
            value={confirmPin}
            onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, ""))}
            className={input}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-slate-300">Your account PIN</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            className="w-full rounded-xl border border-white/15 bg-[#0a0d12] px-3 py-2"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3 sm:col-span-3">
          <button
            disabled={busy}
            className="min-h-11 rounded-xl bg-emerald-600 px-5 font-bold disabled:opacity-50"
          >
            {busy ? "Saving…" : pinSet ? "Change PIN" : "Set PIN"}
          </button>
          {message && (
            <p
              role={message.ok ? "status" : "alert"}
              className={`text-sm ${message.ok ? "text-emerald-300" : "text-rose-300"}`}
            >
              {message.text}
            </p>
          )}
        </div>
      </form>
    </section>
  );
}
