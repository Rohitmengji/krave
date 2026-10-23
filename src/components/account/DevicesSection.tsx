"use client";

import React, { useState } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { RequestFailure, requestJson } from "@/lib/requestJson";
import { SECONDARY_BUTTON, Section, errorText } from "./accountUi";

type SignOutState =
  | { readonly status: "idle" }
  | { readonly status: "confirming"; readonly error: string | null }
  | { readonly status: "working" };

export function DevicesSection({
  primaryHex,
  onSignedOut,
}: {
  primaryHex: string;
  onSignedOut: () => void;
}) {
  const [state, setState] = useState<SignOutState>({ status: "idle" });

  async function signOutEverywhere() {
    if (state.status === "working") return;
    setState({ status: "working" });
    try {
      await requestJson("/api/webroutes/auth/logout-everywhere", {
        method: "POST",
        fallbackMessage: "Could not sign out your devices.",
      });
      onSignedOut();
    } catch (caught) {
      // No session left to end: the result the user asked for already holds.
      if (caught instanceof RequestFailure && caught.status === 401) {
        onSignedOut();
        return;
      }
      setState({ status: "confirming", error: errorText(caught, "Could not sign out your devices.") });
    }
  }

  return (
    <Section
      title="Signed-in devices"
      description="Lost a phone, or signed in on a shared computer? Sign out everywhere, including here."
      testId="account-devices"
    >
      <button
        type="button"
        data-testid="sign-out-everywhere"
        onClick={() => setState({ status: "confirming", error: null })}
        className={SECONDARY_BUTTON}
      >
        Sign out everywhere
      </button>
      <ConfirmDialog
        isOpen={state.status !== "idle"}
        title="Sign out on every device?"
        description="Every phone, tablet and computer signed in to this account will need the password again, including this one."
        confirmLabel="Sign out everywhere"
        busy={state.status === "working"}
        busyLabel="Signing out..."
        error={state.status === "confirming" ? state.error : null}
        primaryHex={primaryHex}
        onConfirm={() => void signOutEverywhere()}
        onCancel={() => setState({ status: "idle" })}
      />
    </Section>
  );
}
