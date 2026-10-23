"use client";

import React, { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { requestJson } from "@/lib/requestJson";
import { DELETE_CONFIRMATION_WORD } from "@/lib/accountRules";
import { FIELD, Section, errorText } from "./accountUi";

type DeleteState =
  | { readonly status: "idle" }
  | { readonly status: "confirming"; readonly error: string | null }
  | { readonly status: "deleting" };

export function DeleteAccountSection({ onDeleted }: { onDeleted: () => void }) {
  const [state, setState] = useState<DeleteState>({ status: "idle" });
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const ready = password.length > 0 && typed.trim() === DELETE_CONFIRMATION_WORD;
  const deleting = state.status === "deleting";

  function close() {
    setState({ status: "idle" });
    setPassword("");
    setTyped("");
  }

  async function deleteAccount() {
    if (state.status !== "confirming" || !ready) return;
    setState({ status: "deleting" });
    try {
      await requestJson("/api/webroutes/account/delete", {
        body: { password, confirmation: typed.trim() },
        timeoutMs: 15000,
        fallbackMessage: "Could not delete your account.",
      });
      onDeleted();
    } catch (caught) {
      setPassword("");
      setState({ status: "confirming", error: errorText(caught, "Could not delete your account.") });
    }
  }

  return (
    <Section
      title="Delete account"
      description="Removes your account with its orders, table bookings, bookmarks, notifications, refund claims and any terminal data synced to it. Table bills you claimed stay with the restaurant. This can't be undone."
      testId="account-delete"
      danger
    >
      <button
        type="button"
        data-testid="delete-account-open"
        onClick={() => setState({ status: "confirming", error: null })}
        className="inline-flex min-h-11 items-center justify-center rounded-2xl border border-rose-500/50 px-4 text-sm font-bold text-rose-300 hover:bg-rose-500/10"
      >
        Delete account...
      </button>
      <ConfirmDialog
        isOpen={state.status !== "idle"}
        title="Delete your account?"
        description="Everything saved to it goes too, and you are signed out on every device. This can't be undone."
        confirmLabel="Delete account"
        cancelLabel="Keep account"
        tone="danger"
        busy={deleting}
        busyLabel="Deleting..."
        error={state.status === "confirming" ? state.error : null}
        confirmDisabled={!ready}
        testId="delete-account-dialog"
        onConfirm={() => void deleteAccount()}
        onCancel={close}
      >
        <div className="space-y-3">
          <label className="block space-y-1 text-xs">
            <span className="text-white/75">Password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={deleting}
              className={FIELD}
            />
          </label>
          <label className="block space-y-1 text-xs">
            <span className="text-white/75">
              Type <strong className="font-black text-white">{DELETE_CONFIRMATION_WORD}</strong> to
              confirm
            </span>
            <input
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              disabled={deleting}
              className={FIELD}
            />
          </label>
        </div>
      </ConfirmDialog>
    </Section>
  );
}
