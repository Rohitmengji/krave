"use client";

import Link from "next/link";
import React, { useEffect, useId, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { CheckCircle2 } from "lucide-react";
import { ForgotPasswordPanel } from "./ForgotPasswordPanel";
import { requestJson, RequestFailure } from "@/lib/requestJson";
import {
  newPasswordProblem,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  readResetToken,
  RESET_PAGE_PATH,
  RESET_START,
  resetReducer,
  SIGN_IN_PATH,
} from "@/lib/passwordReset";
import { primaryFill } from "@/lib/themeContrast";

function subscribeToHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
const readHash = () => window.location.hash;
/** The fragment never reaches the server, so the first render cannot know the token. */
const unknownOnServer = () => null;

const FIELD = "w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 py-2.5 text-sm";
const SECONDARY_LINK = "font-bold underline underline-offset-2";

export function ResetPasswordForm({ primaryHex }: { primaryHex: string }) {
  const hash = useSyncExternalStore(subscribeToHash, readHash, unknownOnServer);
  // Held here, not in the form: success strips the spent token from the address bar.
  const [done, setDone] = useState(false);

  if (done) return <PasswordUpdated primaryHex={primaryHex} />;
  if (hash === null) return <NewPasswordForm token={null} primaryHex={primaryHex} onDone={() => {}} />;
  const token = readResetToken(hash);
  if (!token) return <MissingLink primaryHex={primaryHex} />;
  // Keyed, so opening a newer link in this tab starts clean instead of showing the old outcome.
  return (
    <NewPasswordForm key={token} token={token} primaryHex={primaryHex} onDone={() => setDone(true)} />
  );
}

/** The last attempt timed out and may have landed, so "already used" may mean it worked. */
const MAYBE_SAVED =
  "This link has now been used, most likely by your last try, which may have gone through. Try signing in with the new password first. If that fails, ask for a new link below.";

function NewPasswordForm({
  token,
  primaryHex,
  onDone,
}: {
  /** Null until the browser has read the link; the form shows but cannot submit. */
  token: string | null;
  primaryHex: string;
  onDone: () => void;
}) {
  const [state, dispatch] = useReducer(resetReducer, RESET_START);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [visible, setVisible] = useState(false);
  const [email, setEmail] = useState("");
  const inFlight = useRef(false);
  const outcomeUnknown = useRef(false);
  const deadHeading = useRef<HTMLHeadingElement>(null);
  const hintId = useId();
  const errorId = useId();

  useEffect(() => {
    if (state.status === "link-dead") deadHeading.current?.focus();
  }, [state.status]);

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!token || inFlight.current || state.status !== "editing") return;
    const problem = newPasswordProblem(password, confirmation);
    if (problem) {
      dispatch({ type: "REFUSED", message: problem });
      return;
    }
    inFlight.current = true;
    dispatch({ type: "SAVE" });
    try {
      await requestJson("/api/webroutes/auth/reset", {
        body: { token, password },
        timeoutMs: 15000,
        fallbackMessage: "Could not save that password. Please try again.",
      });
      window.history.replaceState(null, "", RESET_PAGE_PATH);
      onDone();
    } catch (caught) {
      if (caught instanceof RequestFailure && caught.status === 410) {
        dispatch({
          type: "LINK_DEAD",
          message: outcomeUnknown.current ? MAYBE_SAVED : caught.message,
        });
      } else {
        if (caught instanceof RequestFailure && caught.outcomeUnknown) outcomeUnknown.current = true;
        dispatch({
          type: "REFUSED",
          message:
            caught instanceof Error ? caught.message : "Could not save that password. Please try again.",
        });
      }
    } finally {
      inFlight.current = false;
    }
  }

  if (state.status === "link-dead") {
    return (
      <div className="space-y-4" data-testid="reset-link-dead">
        <div className="space-y-1.5">
          <h1 ref={deadHeading} tabIndex={-1} className="text-xl font-black outline-offset-4">
            This link no longer works
          </h1>
          <p className="text-sm leading-relaxed text-white/75">{state.message}</p>
        </div>
        <p className="text-xs text-white/70">Enter your email and we&apos;ll send a fresh link.</p>
        <ForgotPasswordPanel email={email} onEmailChange={setEmail} isDark primaryHex={primaryHex} />
        <p className="text-center text-xs text-white/70">
          <Link href={SIGN_IN_PATH} className={SECONDARY_LINK}>
            Back to sign in
          </Link>
        </p>
      </div>
    );
  }

  const saving = state.status === "saving";
  const error = state.status === "editing" ? state.error : null;
  const describedBy = error ? `${hintId} ${errorId}` : hintId;
  return (
    <form onSubmit={save} noValidate className="space-y-4" data-testid="reset-form">
      <div className="space-y-1.5">
        <h1 className="text-xl font-black">Choose a new password</h1>
        <p id={hintId} className="text-sm leading-relaxed text-white/75">
          At least {PASSWORD_MIN_LENGTH} characters. You&apos;ll be signed out everywhere, then sign
          in again with the new one.
        </p>
      </div>

      <label className="block space-y-1 text-xs">
        <span className="text-white/75">New password</span>
        <input
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          maxLength={PASSWORD_MAX_LENGTH}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={!token || saving}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={FIELD}
        />
      </label>

      <label className="block space-y-1 text-xs">
        <span className="text-white/75">Type it again</span>
        <input
          type={visible ? "text" : "password"}
          autoComplete="new-password"
          maxLength={PASSWORD_MAX_LENGTH}
          value={confirmation}
          onChange={(event) => setConfirmation(event.target.value)}
          disabled={!token || saving}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={FIELD}
        />
      </label>

      <label className="flex min-h-11 w-fit items-center gap-2 text-xs text-white/75">
        <input
          type="checkbox"
          checked={visible}
          onChange={(event) => setVisible(event.target.checked)}
          className="h-4 w-4"
        />
        Show passwords
      </label>

      {error && (
        <p id={errorId} role="alert" className="text-sm text-rose-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        data-testid="reset-submit"
        disabled={!token || saving}
        aria-busy={saving}
        className="w-full rounded-2xl py-3 text-sm font-black text-white disabled:opacity-50"
        style={{ backgroundColor: primaryFill(primaryHex) }}
      >
        {saving ? "Saving..." : "Save new password"}
      </button>

      <p className="text-center text-xs text-white/70">
        Remembered it?{" "}
        <Link href={SIGN_IN_PATH} className={SECONDARY_LINK}>
          Sign in
        </Link>
      </p>
    </form>
  );
}

function MissingLink({ primaryHex }: { primaryHex: string }) {
  const [email, setEmail] = useState("");
  return (
    <div className="space-y-4" data-testid="reset-missing-link">
      <div className="space-y-1.5">
        <h1 className="text-xl font-black">Open the link from your email</h1>
        <p className="text-sm leading-relaxed text-white/75">
          This page needs the link from your reset email. Can&apos;t find it, or it has expired?
          Ask for a new one here. Only the newest link works.
        </p>
      </div>
      <ForgotPasswordPanel email={email} onEmailChange={setEmail} isDark primaryHex={primaryHex} />
      <p className="text-center text-xs text-white/70">
        <Link href={SIGN_IN_PATH} className={SECONDARY_LINK}>
          Back to sign in
        </Link>
      </p>
    </div>
  );
}

function PasswordUpdated({ primaryHex }: { primaryHex: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    // The form and its focused button are gone; focus lands on the outcome instead.
    heading.current?.focus();
  }, []);
  return (
    <div className="space-y-4" data-testid="reset-done">
      <CheckCircle2 className="h-8 w-8 text-emerald-400" aria-hidden="true" />
      <div className="space-y-1.5">
        <h1 ref={heading} tabIndex={-1} className="text-xl font-black outline-offset-4">
          Password updated
        </h1>
        <p className="text-sm leading-relaxed text-white/75">
          You&apos;re signed out on every device, including this one. Sign in with your new
          password.
        </p>
      </div>
      <Link
        href={SIGN_IN_PATH}
        data-testid="reset-sign-in"
        className="block w-full rounded-2xl py-3 text-center text-sm font-black text-white"
        style={{ backgroundColor: primaryFill(primaryHex) }}
      >
        Sign in
      </Link>
    </div>
  );
}
