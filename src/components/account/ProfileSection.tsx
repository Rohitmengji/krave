"use client";

import React, { useId, useReducer, useRef, useState } from "react";
import { requestJson } from "@/lib/requestJson";
import { primaryFill } from "@/lib/themeContrast";
import {
  DISPLAY_NAME_MAX_LENGTH,
  displayNameProblem,
  formatPhone,
  normalizePhone,
  readAccountProfile,
  SECTION_START,
  sectionReducer,
  type AccountProfile,
} from "@/lib/accountRules";
import { errorText, FIELD, PRIMARY_BUTTON, Section, SectionOutcome } from "./accountUi";

export function ProfileSection({
  user,
  primaryHex,
  onUpdated,
}: {
  user: AccountProfile;
  primaryHex: string;
  onUpdated: (user: AccountProfile) => void;
}) {
  const [name, setName] = useState(user.displayName);
  const [phone, setPhone] = useState(user.phone ? formatPhone(user.phone) : "");
  const [state, dispatch] = useReducer(sectionReducer, SECTION_START);
  const inFlight = useRef(false);
  const errorId = useId();
  const phoneHintId = useId();

  const parsedPhone = normalizePhone(phone);
  const unchanged =
    name.trim() === user.displayName && parsedPhone.ok && parsedPhone.phone === user.phone;
  const saving = state.status === "saving";
  const error = state.status === "editing" ? state.error : null;

  function edit(update: () => void) {
    update();
    dispatch({ type: "EDIT" });
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current || state.status !== "editing" || unchanged) return;
    const problem = displayNameProblem(name) ?? (parsedPhone.ok ? null : parsedPhone.message);
    if (problem) {
      dispatch({ type: "REFUSED", message: problem });
      return;
    }
    inFlight.current = true;
    dispatch({ type: "SAVE" });
    try {
      const reply = await requestJson("/api/webroutes/account/profile", {
        body: { displayName: name.trim(), phone: parsedPhone.ok ? (parsedPhone.phone ?? "") : phone },
        fallbackMessage: "Could not save your profile.",
      });
      const updated = readAccountProfile(reply);
      if (updated) {
        onUpdated(updated);
        setName(updated.displayName);
        setPhone(updated.phone ? formatPhone(updated.phone) : "");
      }
      dispatch({ type: "SAVED", notice: "Profile saved." });
    } catch (caught) {
      dispatch({ type: "FAILED", message: errorText(caught, "Could not save your profile.") });
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <Section title="Profile" testId="account-profile">
      <form onSubmit={save} noValidate className="space-y-4">
        <label className="block space-y-1 text-xs">
          <span className="text-white/75">Name</span>
          <input
            value={name}
            onChange={(event) => edit(() => setName(event.target.value))}
            autoComplete="name"
            maxLength={DISPLAY_NAME_MAX_LENGTH + 20}
            disabled={saving}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className={FIELD}
          />
        </label>
        <div className="space-y-1">
          <label className="block space-y-1 text-xs">
            <span className="text-white/75">Mobile number (optional)</span>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={phone}
              onChange={(event) => edit(() => setPhone(event.target.value))}
              placeholder="98765 43210"
              maxLength={32}
              disabled={saving}
              aria-invalid={error && !parsedPhone.ok ? true : undefined}
              aria-describedby={error ? `${phoneHintId} ${errorId}` : phoneHintId}
              className={FIELD}
            />
          </label>
          <p id={phoneHintId} className="text-xs text-white/60">
            Kept on your account only. Use + and the country code for a number outside India.
          </p>
        </div>
        <SectionOutcome state={state} errorId={errorId} />
        <button
          type="submit"
          data-testid="profile-save"
          disabled={saving || unchanged}
          aria-busy={saving}
          className={PRIMARY_BUTTON}
          style={{ backgroundColor: primaryFill(primaryHex) }}
        >
          {saving ? "Saving..." : "Save profile"}
        </button>
      </form>
    </Section>
  );
}
