"use client";

import Link from "next/link";
import React, { useEffect, useReducer, useRef, useSyncExternalStore } from "react";
import { CheckCircle2, MailCheck } from "lucide-react";
import { requestJson, RequestFailure } from "@/lib/requestJson";
import { primaryFill } from "@/lib/themeContrast";
import { readResetToken } from "@/lib/passwordReset";
import { ACCOUNT_PATH, VERIFY_EMAIL_PATH, VERIFY_START, verifyReducer } from "@/lib/accountRules";

function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
const readHash = () => window.location.hash;
const unknownOnServer = () => null;

const LINK = "font-bold underline underline-offset-2";

/**
 * Confirms on a click rather than on load: mail scanners that open links would otherwise
 * spend the token before the person ever sees the page.
 */
export function VerifyEmailConfirm({ primaryHex }: { primaryHex: string }) {
  const hash = useSyncExternalStore(subscribeToHash, readHash, unknownOnServer);
  const token = hash === null ? null : readResetToken(hash);
  const [state, dispatch] = useReducer(verifyReducer, VERIFY_START);
  const inFlight = useRef(false);
  const outcomeHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (state.status === "done" || (state.status === "failed" && state.dead)) {
      outcomeHeading.current?.focus();
    }
  }, [state]);

  async function confirmAddress() {
    if (!token || inFlight.current) return;
    inFlight.current = true;
    dispatch({ type: "CONFIRM" });
    try {
      const reply = (await requestJson("/api/webroutes/auth/verify-email", {
        body: { token },
        fallbackMessage: "Could not confirm that email address.",
      })) as { purpose?: unknown; email?: unknown } | null;
      // The token is spent; it should not stay in the address bar or history.
      window.history.replaceState(null, "", VERIFY_EMAIL_PATH);
      dispatch({
        type: "CONFIRMED",
        purpose: reply?.purpose === "change" ? "change" : "verify",
        email: typeof reply?.email === "string" ? reply.email : "",
      });
    } catch (caught) {
      const dead = caught instanceof RequestFailure && (caught.status === 410 || caught.status === 409);
      dispatch({
        type: "FAILED",
        message: caught instanceof Error ? caught.message : "Could not confirm that email address.",
        dead,
      });
    } finally {
      inFlight.current = false;
    }
  }

  if (state.status === "done") {
    return (
      <div className="space-y-4" data-testid="verify-done">
        <CheckCircle2 className="h-8 w-8 text-emerald-400" aria-hidden="true" />
        <h1 ref={outcomeHeading} tabIndex={-1} className="text-xl font-black outline-offset-4">
          {state.purpose === "change" ? "Email address changed" : "Email address confirmed"}
        </h1>
        <p className="text-sm leading-relaxed text-white/75">
          {state.purpose === "change"
            ? `Your account now uses ${state.email}. Sign in with it from now on.`
            : `${state.email} is confirmed. Password reset links and account notices will reach you there.`}
        </p>
        <Link
          href={ACCOUNT_PATH}
          className="block w-full rounded-2xl py-3 text-center text-sm font-black text-white"
          style={{ backgroundColor: primaryFill(primaryHex) }}
        >
          Go to your account
        </Link>
      </div>
    );
  }

  if (state.status === "failed" && state.dead) {
    return (
      <div className="space-y-4" data-testid="verify-dead">
        <h1 ref={outcomeHeading} tabIndex={-1} className="text-xl font-black outline-offset-4">
          This link no longer works
        </h1>
        <p className="text-sm leading-relaxed text-white/75">{state.message}</p>
        <p className="text-sm text-white/75">
          You can send a new link from{" "}
          <Link href={ACCOUNT_PATH} className={LINK}>
            your account
          </Link>
          .
        </p>
      </div>
    );
  }

  if (hash !== null && !token) {
    return (
      <div className="space-y-3" data-testid="verify-missing">
        <h1 className="text-xl font-black">Open the link from your email</h1>
        <p className="text-sm leading-relaxed text-white/75">
          This page needs the link from your confirmation email. If it has expired, send a new one
          from{" "}
          <Link href={ACCOUNT_PATH} className={LINK}>
            your account
          </Link>
          .
        </p>
      </div>
    );
  }

  const confirming = state.status === "confirming";
  return (
    <div className="space-y-4" data-testid="verify-ready">
      <MailCheck className="h-8 w-8 text-emerald-400" aria-hidden="true" />
      <div className="space-y-1.5">
        <h1 className="text-xl font-black">Confirm your email address</h1>
        <p className="text-sm leading-relaxed text-white/75">
          One click finishes it. The link works once.
        </p>
      </div>
      {state.status === "failed" && (
        <p role="alert" className="text-sm text-rose-400">
          {state.message}
        </p>
      )}
      <button
        type="button"
        data-testid="verify-confirm"
        onClick={confirmAddress}
        disabled={!token || confirming}
        aria-busy={confirming}
        className="w-full rounded-2xl py-3 text-sm font-black text-white disabled:opacity-50"
        style={{ backgroundColor: primaryFill(primaryHex) }}
      >
        {confirming ? "Confirming..." : "Confirm email address"}
      </button>
    </div>
  );
}
