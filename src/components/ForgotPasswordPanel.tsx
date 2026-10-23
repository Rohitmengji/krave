"use client";

import React, { useEffect, useId, useReducer, useRef } from "react";
import { MailCheck } from "lucide-react";
import { requestJson } from "@/lib/requestJson";
import {
  FORGOT_START,
  forgotReducer,
  readResetDelivery,
  RESET_LINK_MINUTES,
} from "@/lib/passwordReset";
import { primaryFill } from "@/lib/themeContrast";

/** Asks for a reset link and confirms it was sent, without revealing whether the account exists. */
export function ForgotPasswordPanel({
  email,
  onEmailChange,
  onBack,
  isDark,
  primaryHex,
  autoFocusEmail = false,
}: {
  email: string;
  onEmailChange: (email: string) => void;
  /** Returns to the sign-in form. Omitted where the page offers its own way back. */
  onBack?: () => void;
  isDark: boolean;
  primaryHex: string;
  autoFocusEmail?: boolean;
}) {
  const [state, dispatch] = useReducer(forgotReducer, FORGOT_START);
  const inFlight = useRef(false);
  const sentHeading = useRef<HTMLHeadingElement>(null);
  const errorId = useId();

  useEffect(() => {
    // The form that held focus is gone; without this, focus falls to the page.
    if (state.status === "sent") sentHeading.current?.focus();
  }, [state.status]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    const address = email.trim();
    dispatch({ type: "SEND" });
    try {
      const reply = await requestJson("/api/webroutes/auth/forgot", {
        body: { email: address },
        timeoutMs: 15000,
        fallbackMessage: "Could not send a reset link. Please try again.",
      });
      dispatch({ type: "SENT", email: address, delivery: readResetDelivery(reply) });
    } catch (caught) {
      dispatch({
        type: "FAILED",
        message:
          caught instanceof Error ? caught.message : "Could not send a reset link. Please try again.",
      });
    } finally {
      inFlight.current = false;
    }
  }

  const field = isDark ? "bg-[#0E131D] border-white/15" : "bg-slate-50 border-slate-200";
  const backButton = onBack && (
    <button
      type="button"
      data-testid="forgot-back"
      onClick={onBack}
      className="w-full rounded-2xl border border-current/20 py-2.5 text-xs font-black"
    >
      Back to sign in
    </button>
  );

  if (state.status === "sent") {
    return (
      <div className="space-y-3" data-testid="forgot-sent">
        <h3
          ref={sentHeading}
          tabIndex={-1}
          className="flex items-center gap-2 text-sm font-black outline-offset-4"
        >
          <MailCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
          Check your inbox
        </h3>
        <p className="text-xs leading-relaxed opacity-80">
          If an account exists for <strong className="wrap-break-word">{state.email}</strong>, a link to
          choose a new password is on its way. It works once and expires in {RESET_LINK_MINUTES}{" "}
          minutes.
        </p>
        {state.delivery === "server-log" && (
          <p className={`rounded-xl border px-3 py-2 text-xs ${field}`}>
            Email isn&apos;t set up on this server, so the link was written to the server log
            instead.
          </p>
        )}
        <p className="text-xs opacity-70">
          Not there after a few minutes? Check your spam folder, or{" "}
          <button
            type="button"
            data-testid="forgot-send-another"
            onClick={() => dispatch({ type: "EDIT" })}
            className="font-bold underline underline-offset-2"
          >
            send another link
          </button>
          .
        </p>
        {backButton}
      </div>
    );
  }

  const sending = state.status === "sending";
  const error = state.status === "editing" ? state.error : null;
  return (
    <form onSubmit={send} className="space-y-3" data-testid="forgot-form">
      <label className="block space-y-1 text-xs">
        <span className="opacity-70">Email you signed up with</span>
        <input
          type="email"
          required
          autoComplete="email"
          autoFocus={autoFocusEmail}
          value={email}
          onChange={(event) => onEmailChange(event.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={`w-full rounded-xl border px-3 py-2 ${field}`}
        />
      </label>

      {error && (
        <p id={errorId} role="alert" className="text-xs text-rose-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        data-testid="forgot-submit"
        disabled={sending}
        aria-busy={sending}
        className="w-full rounded-2xl py-2.5 text-xs font-black text-white disabled:opacity-50"
        style={{ backgroundColor: primaryFill(primaryHex) }}
      >
        {sending ? "Sending..." : "Email me a reset link"}
      </button>
      {backButton}
    </form>
  );
}
