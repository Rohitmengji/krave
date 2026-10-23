"use client";

import React, { useState } from "react";
import { LogIn, UserPlus, X } from "lucide-react";
import { OverlayDialog } from "./OverlayDialog";
import { ForgotPasswordPanel } from "./ForgotPasswordPanel";
import { requestJson } from "@/lib/requestJson";
import type { BrandThemePreset } from "@/types/krave";
import { primaryFill } from "@/lib/themeContrast";

export interface AccountUser {
  id: string;
  email: string;
  displayName: string;
  isGoldMember: boolean;
}

export function AccountDialog({
  isOpen,
  onClose,
  theme,
  isDark,
  user,
  onAuthenticated,
  onSignOut,
}: {
  isOpen: boolean;
  onClose: () => void;
  theme: BrandThemePreset;
  isDark: boolean;
  user: AccountUser | null;
  onAuthenticated: (payload: unknown) => void;
  onSignOut: () => Promise<void>;
}) {
  const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whoever opens the dialog next came to sign in, not to finish a reset they walked away from.
  function close() {
    if (mode === "forgot") setMode("login");
    onClose();
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (pending || mode === "forgot") return;
    setPending(true);
    setError(null);
    try {
      const result = await requestJson(`/api/webroutes/auth/${mode}`, {
        method: "POST",
        body: { email, password, displayName },
        timeoutMs: 10000,
        fallbackMessage: "Could not sign you in.",
      });
      setPassword("");
      onAuthenticated(result);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not sign you in.");
    } finally {
      setPending(false);
    }
  }

  const surface = isDark
    ? "bg-[#121721] border-white/15 text-white"
    : "bg-white border-slate-200 text-slate-900";
  const field = isDark
    ? "bg-[#0E131D] border-white/15"
    : "bg-slate-50 border-slate-200";

  return (
    <OverlayDialog isOpen={isOpen} onClose={close} label="Account">
      <div className={`space-y-4 rounded-3xl border p-6 ${surface}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-black">
              {user ? "Your account" : mode === "forgot" ? "Reset your password" : "Sign in to KRAVE"}
            </h2>
            <p className="text-xs opacity-65">
              {user
                ? "Orders, bookings and bookmarks are saved to this account."
                : mode === "forgot"
                  ? "We'll email you a link to choose a new one."
                  : "Optional. Without an account everything stays in this browser."}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close account"
            onClick={close}
            className="rounded-lg p-1 hover:bg-white/10"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {user ? (
          <div className="space-y-3">
            <dl className={`rounded-2xl border p-3.5 text-xs space-y-1 ${field}`}>
              <div className="flex justify-between">
                <dt className="opacity-65">Signed in as</dt>
                <dd className="font-bold">{user.displayName}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="opacity-65">Email</dt>
                <dd className="font-bold">{user.email}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="opacity-65">{theme.membershipName}</dt>
                <dd className="font-bold">{user.isGoldMember ? "Active" : "Off"}</dd>
              </div>
            </dl>
            <button
              type="button"
              data-testid="account-sign-out"
              onClick={async () => {
                await onSignOut();
                onClose();
              }}
              className="w-full rounded-2xl border border-current/20 py-2.5 text-xs font-black"
            >
              Sign out
            </button>
          </div>
        ) : mode === "forgot" ? (
          <ForgotPasswordPanel
            email={email}
            onEmailChange={setEmail}
            onBack={() => setMode("login")}
            isDark={isDark}
            primaryHex={theme.primaryHex}
            autoFocusEmail
          />
        ) : (
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="grid grid-cols-2 gap-2">
              {(["login", "register"] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  data-testid={`account-mode-${option}`}
                  onClick={() => {
                    setMode(option);
                    setError(null);
                  }}
                  className={`flex items-center justify-center gap-1.5 rounded-xl border py-2 text-xs font-bold transition ${
                    mode === option ? "text-white border-transparent" : "border-current/20"
                  }`}
                  style={mode === option ? { backgroundColor: primaryFill(theme.primaryHex) } : undefined}
                >
                  {option === "login" ? (
                    <>
                      <LogIn className="w-3.5 h-3.5" /> Sign in
                    </>
                  ) : (
                    <>
                      <UserPlus className="w-3.5 h-3.5" /> Create account
                    </>
                  )}
                </button>
              ))}
            </div>

            {mode === "register" && (
              <label className="block space-y-1 text-xs">
                <span className="opacity-70">Name</span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  className={`w-full rounded-xl border px-3 py-2 ${field}`}
                />
              </label>
            )}

            <label className="block space-y-1 text-xs">
              <span className="opacity-70">Email</span>
              <input
                type="email"
                required
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                className={`w-full rounded-xl border px-3 py-2 ${field}`}
              />
            </label>

            <label className="block space-y-1 text-xs">
              <span className="opacity-70">Password (minimum 10 characters)</span>
              <input
                type="password"
                required
                minLength={10}
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                className={`w-full rounded-xl border px-3 py-2 ${field}`}
              />
            </label>

            {mode === "login" && (
              <div className="-my-2 flex justify-end">
                <button
                  type="button"
                  data-testid="account-forgot"
                  onClick={() => {
                    setMode("forgot");
                    setError(null);
                  }}
                  className="inline-flex min-h-11 items-center px-1 text-xs font-bold underline-offset-2 hover:underline"
                  style={{ color: "var(--brand-ink)" }}
                >
                  Forgot password?
                </button>
              </div>
            )}

            {error && (
              <p role="alert" className="text-xs text-rose-400">
                {error}
              </p>
            )}

            <p className="text-[10px] opacity-60">
              Demo accounts only. Don&apos;t reuse a password you use anywhere else.
            </p>

            <button
              type="submit"
              data-testid="account-submit"
              disabled={pending}
              aria-busy={pending}
              className="w-full rounded-2xl py-2.5 text-xs font-black text-white disabled:opacity-50"
              style={{ backgroundColor: primaryFill(theme.primaryHex) }}
            >
              {pending ? "Working..." : mode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>
        )}
      </div>
    </OverlayDialog>
  );
}
