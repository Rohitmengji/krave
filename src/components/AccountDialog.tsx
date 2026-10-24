"use client";

import React, { useState } from "react";
import Link from "next/link";
import { LogIn, UserPlus, X } from "lucide-react";
import { OverlayDialog } from "./OverlayDialog";
import { ForgotPasswordPanel } from "./ForgotPasswordPanel";
import { requestJson } from "@/lib/requestJson";
import type { BrandThemePreset } from "@/types/krave";
import { primaryFill } from "@/lib/themeContrast";
import { ACCOUNT_PATH, normalizePhone, registrationProblem } from "@/lib/accountRules";
import { pinProblem } from "@/lib/passwordReset";

export interface AccountUser {
  id: string;
  email: string;
  displayName: string;
  isGoldMember: boolean;
  phone: string | null;
  emailVerified: boolean;
}

export function AccountDialog({
  isOpen,
  onClose,
  theme,
  isDark,
  user,
  onAuthenticated,
  onSignOut,
  required = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  theme: BrandThemePreset;
  isDark: boolean;
  user: AccountUser | null;
  onAuthenticated: (payload: unknown) => void;
  onSignOut: () => Promise<void>;
  /** Signed-out visitors cannot dismiss this; the app stays behind the account. */
  required?: boolean;
}) {
  const [mode, setMode] = useState<"login" | "register" | "forgot">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Whoever opens the dialog next came to sign in, not to finish a reset they walked away from.
  const locked = required && !user;

  function close() {
    if (locked) return;
    if (mode === "forgot") setMode("login");
    onClose();
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (pending || mode === "forgot") return;
    const problem =
      mode === "register"
        ? registrationProblem({ displayName, phone, password })
        : pinProblem(password);
    if (problem) {
      setError(problem);
      return;
    }
    const normalised = mode === "register" ? normalizePhone(phone) : null;
    setPending(true);
    setError(null);
    try {
      const result = await requestJson(`/api/webroutes/auth/${mode}`, {
        method: "POST",
        body: {
          email,
          password,
          displayName,
          phone: normalised && normalised.ok ? normalised.phone : undefined,
        },
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
              {user ? "Your account" : mode === "forgot" ? "Reset your PIN" : "Sign in to KRAVE"}
            </h2>
            <p className="text-xs opacity-65">
              {user
                ? "Orders, bookings and bookmarks are saved to this account."
                : mode === "forgot"
                  ? "We'll email you a link to choose a new PIN."
                  : "Create an account or sign in with your email and a 6-digit PIN. The app stays closed until you do."}
            </p>
          </div>
          {!locked && (
            <button
              type="button"
              aria-label="Close account"
              onClick={close}
              className="rounded-lg p-1 hover:bg-white/10"
            >
              <X className="w-4 h-4" />
            </button>
          )}
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
            </dl>
            {!user.emailVerified && (
              <p className="rounded-2xl border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs leading-relaxed">
                Confirm your email address so you can always get back in. Look for our link at{" "}
                <strong className="wrap-break-word">{user.email}</strong>, or send a new one from
                Manage account.
              </p>
            )}
            <Link
              href={ACCOUNT_PATH}
              data-testid="account-manage"
              className="flex min-h-11 w-full items-center justify-center rounded-2xl py-2.5 text-xs font-black text-white"
              style={{ backgroundColor: primaryFill(theme.primaryHex) }}
            >
              Manage account
            </Link>
            <button
              type="button"
              data-testid="account-sign-out"
              onClick={async () => {
                // Closing first lets the page, not a dialog on its way out, announce the result.
                onClose();
                await onSignOut();
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
              <>
                <label className="block space-y-1 text-xs">
                  <span className="opacity-70">Name</span>
                  <input
                    type="text"
                    required
                    autoComplete="name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    className={`w-full rounded-xl border px-3 py-2 ${field}`}
                  />
                </label>
                <label className="block space-y-1 text-xs">
                  <span className="opacity-70">Mobile number</span>
                  <input
                    type="tel"
                    required
                    inputMode="tel"
                    autoComplete="tel"
                    value={phone}
                    onChange={(event) => setPhone(event.target.value)}
                    className={`w-full rounded-xl border px-3 py-2 ${field}`}
                  />
                </label>
              </>
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
              <span className="opacity-70">PIN (6 to 8 digits)</span>
              <input
                type="password"
                required
                inputMode="numeric"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                minLength={6}
                maxLength={8}
                pattern="\d{6,8}"
                value={password}
                onChange={(event) => setPassword(event.target.value.replace(/\D/g, "").slice(0, 8))}
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
                  Forgot PIN?
                </button>
              </div>
            )}

            {error && (
              <p role="alert" className="text-xs text-rose-400">
                {error}
              </p>
            )}

            <p className="text-[10px] opacity-60">
              Use a numeric PIN of at least 6 digits. Don&apos;t reuse a PIN you use anywhere else.
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
