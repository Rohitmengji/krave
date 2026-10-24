"use client";

import React, { useId, useReducer, useRef, useState } from "react";
import { BadgeCheck, MailWarning } from "lucide-react";
import { requestJson } from "@/lib/requestJson";
import { primaryFill } from "@/lib/themeContrast";
import { readResetDelivery } from "@/lib/passwordReset";
import {
  EMAIL_CHANGE_LINK_MINUTES,
  SECTION_START,
  sectionReducer,
  VERIFY_LINK_HOURS,
  type AccountProfile,
} from "@/lib/accountRules";
import {
  errorText,
  FIELD,
  PRIMARY_BUTTON,
  SECONDARY_BUTTON,
  Section,
  SectionOutcome,
} from "./accountUi";

const LOGGED_INSTEAD = " Email isn't set up on this server, so the link was written to the server log.";

export function EmailSection({ user, primaryHex }: { user: AccountProfile; primaryHex: string }) {
  return (
    <Section
      title="Email address"
      description="You sign in with this address, and links to reset your password are sent to it."
      testId="account-email"
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-bold break-all">{user.email}</span>
        {user.emailVerified ? (
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/15 px-2.5 py-1 text-xs font-bold text-emerald-300">
            <BadgeCheck className="h-3.5 w-3.5" aria-hidden="true" />
            Confirmed
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2.5 py-1 text-xs font-bold text-amber-300">
            <MailWarning className="h-3.5 w-3.5" aria-hidden="true" />
            Not confirmed
          </span>
        )}
      </div>
      {!user.emailVerified && <ResendConfirmation email={user.email} />}
      <ChangeEmailForm currentEmail={user.email} primaryHex={primaryHex} />
    </Section>
  );
}

function ResendConfirmation({ email }: { email: string }) {
  const [state, dispatch] = useReducer(sectionReducer, SECTION_START);
  const inFlight = useRef(false);
  const errorId = useId();

  async function resend() {
    if (inFlight.current || state.status !== "editing") return;
    inFlight.current = true;
    dispatch({ type: "SAVE" });
    try {
      const reply = await requestJson("/api/webroutes/account/verify-email/resend", {
        body: {},
        fallbackMessage: "Could not send a confirmation link.",
      });
      const logged = readResetDelivery(reply) === "server-log";
      dispatch({
        type: "SAVED",
        notice: `We sent a confirmation link to ${email}. It works for ${VERIFY_LINK_HOURS} hours.${logged ? LOGGED_INSTEAD : ""}`,
      });
    } catch (caught) {
      dispatch({ type: "FAILED", message: errorText(caught, "Could not send a confirmation link.") });
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <div className="space-y-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3.5">
      <p className="text-sm leading-relaxed text-amber-100">
        Confirm this address so you can always get back into your account.
      </p>
      <SectionOutcome state={state} errorId={errorId} />
      <button
        type="button"
        data-testid="email-resend"
        onClick={resend}
        disabled={state.status === "saving"}
        aria-busy={state.status === "saving"}
        className={SECONDARY_BUTTON}
      >
        {state.status === "saving" ? "Sending..." : "Send confirmation link"}
      </button>
    </div>
  );
}

function ChangeEmailForm({ currentEmail, primaryHex }: { currentEmail: string; primaryHex: string }) {
  const [open, setOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [password, setPassword] = useState("");
  const [state, dispatch] = useReducer(sectionReducer, SECTION_START);
  const inFlight = useRef(false);
  const errorId = useId();
  const saving = state.status === "saving";
  const error = state.status === "editing" ? state.error : null;

  function edit(update: () => void) {
    update();
    dispatch({ type: "EDIT" });
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || state.status !== "editing") return;
    const address = newEmail.trim();
    if (!address || !password) {
      dispatch({ type: "REFUSED", message: "Enter the new address and your current password." });
      return;
    }
    if (address.toLowerCase() === currentEmail) {
      dispatch({ type: "REFUSED", message: "That is already your email address." });
      return;
    }
    inFlight.current = true;
    dispatch({ type: "SAVE" });
    try {
      const reply = await requestJson("/api/webroutes/account/email", {
        body: { newEmail: address, password },
        timeoutMs: 15000,
        fallbackMessage: "Could not start the email change.",
      });
      const pending = (reply as { pendingEmail?: unknown } | null)?.pendingEmail;
      const logged = readResetDelivery(reply) === "server-log";
      setPassword("");
      dispatch({
        type: "SAVED",
        notice: `Check ${typeof pending === "string" ? pending : address}: open the link there within ${EMAIL_CHANGE_LINK_MINUTES} minutes to finish. Until then you still sign in with ${currentEmail}.${logged ? LOGGED_INSTEAD : ""}`,
      });
    } catch (caught) {
      setPassword("");
      dispatch({ type: "FAILED", message: errorText(caught, "Could not start the email change.") });
    } finally {
      inFlight.current = false;
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="email-change-open"
        onClick={() => setOpen(true)}
        className={SECONDARY_BUTTON}
      >
        Change email address
      </button>
    );
  }

  return (
    <form onSubmit={send} noValidate className="space-y-4 border-t border-white/10 pt-4" data-testid="email-change-form">
      <label className="block space-y-1 text-xs">
        <span className="text-white/75">New email address</span>
        <input
          type="email"
          autoComplete="email"
          value={newEmail}
          onChange={(event) => edit(() => setNewEmail(event.target.value))}
          disabled={saving}
          autoFocus
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={FIELD}
        />
      </label>
      <label className="block space-y-1 text-xs">
        <span className="text-white/75">Current PIN</span>
        <input
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => edit(() => setPassword(event.target.value))}
          disabled={saving}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={FIELD}
        />
      </label>
      <SectionOutcome state={state} errorId={errorId} />
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          data-testid="email-change-submit"
          disabled={saving}
          aria-busy={saving}
          className={PRIMARY_BUTTON}
          style={{ backgroundColor: primaryFill(primaryHex) }}
        >
          {saving ? "Sending..." : "Send link to new address"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setNewEmail("");
            setPassword("");
            dispatch({ type: "EDIT" });
          }}
          disabled={saving}
          className={SECONDARY_BUTTON}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
