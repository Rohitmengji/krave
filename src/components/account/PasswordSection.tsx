"use client";

import React, { useId, useReducer, useRef, useState } from "react";
import { requestJson } from "@/lib/requestJson";
import { primaryFill } from "@/lib/themeContrast";
import { newPasswordProblem, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/passwordReset";
import { SECTION_START, sectionReducer } from "@/lib/accountRules";
import { errorText, FIELD, PRIMARY_BUTTON, Section, SectionOutcome } from "./accountUi";

export function PasswordSection({ primaryHex }: { primaryHex: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [visible, setVisible] = useState(false);
  const [state, dispatch] = useReducer(sectionReducer, SECTION_START);
  const inFlight = useRef(false);
  const hintId = useId();
  const errorId = useId();
  const saving = state.status === "saving";
  const error = state.status === "editing" ? state.error : null;
  const describedBy = error ? `${hintId} ${errorId}` : hintId;

  function edit(update: () => void) {
    update();
    dispatch({ type: "EDIT" });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || state.status !== "editing") return;
    if (!current) {
      dispatch({ type: "REFUSED", message: "Enter your current password." });
      return;
    }
    const problem =
      newPasswordProblem(next, confirmation) ??
      (next === current ? "Choose a password different from your current one." : null);
    if (problem) {
      dispatch({ type: "REFUSED", message: problem });
      return;
    }
    inFlight.current = true;
    dispatch({ type: "SAVE" });
    try {
      await requestJson("/api/webroutes/account/password", {
        body: { currentPassword: current, newPassword: next },
        timeoutMs: 15000,
        fallbackMessage: "Could not change your password.",
      });
      setCurrent("");
      setNext("");
      setConfirmation("");
      dispatch({
        type: "SAVED",
        notice: "Password changed. Your other devices were signed out; this one stays signed in.",
      });
    } catch (caught) {
      setCurrent("");
      dispatch({ type: "FAILED", message: errorText(caught, "Could not change your password.") });
    } finally {
      inFlight.current = false;
    }
  }

  const type = visible ? "text" : "password";
  return (
    <Section
      title="Password"
      description="Changing it signs you out on every other device."
      testId="account-password"
    >
      <form onSubmit={save} noValidate className="space-y-4">
        <label className="block space-y-1 text-xs">
          <span className="text-white/75">Current password</span>
          <input
            type={type}
            autoComplete="current-password"
            value={current}
            onChange={(event) => edit(() => setCurrent(event.target.value))}
            disabled={saving}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={FIELD}
          />
        </label>
        <div className="space-y-1">
          <label className="block space-y-1 text-xs">
            <span className="text-white/75">New password</span>
            <input
              type={type}
              autoComplete="new-password"
              maxLength={PASSWORD_MAX_LENGTH}
              value={next}
              onChange={(event) => edit(() => setNext(event.target.value))}
              disabled={saving}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              className={FIELD}
            />
          </label>
          <p id={hintId} className="text-xs text-white/60">
            At least {PASSWORD_MIN_LENGTH} characters, different from the current one.
          </p>
        </div>
        <label className="block space-y-1 text-xs">
          <span className="text-white/75">Type the new password again</span>
          <input
            type={type}
            autoComplete="new-password"
            maxLength={PASSWORD_MAX_LENGTH}
            value={confirmation}
            onChange={(event) => edit(() => setConfirmation(event.target.value))}
            disabled={saving}
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
        <SectionOutcome state={state} errorId={errorId} />
        <button
          type="submit"
          data-testid="password-save"
          disabled={saving}
          aria-busy={saving}
          className={PRIMARY_BUTTON}
          style={{ backgroundColor: primaryFill(primaryHex) }}
        >
          {saving ? "Changing..." : "Change password"}
        </button>
      </form>
    </Section>
  );
}
