"use client";

import Link from "next/link";
import React, { useEffect, useReducer } from "react";
import { CheckCircle2 } from "lucide-react";
import { requestJson } from "@/lib/requestJson";
import { primaryFill } from "@/lib/themeContrast";
import { SIGN_IN_PATH } from "@/lib/passwordReset";
import { accountPageReducer, readAccountProfile } from "@/lib/accountRules";
import { ProfileSection } from "./ProfileSection";
import { EmailSection } from "./EmailSection";
import { PasswordSection } from "./PasswordSection";
import { DevicesSection } from "./DevicesSection";
import { DeleteAccountSection } from "./DeleteAccountSection";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "./accountUi";

export function AccountSettings({ primaryHex }: { primaryHex: string }) {
  const [state, dispatch] = useReducer(accountPageReducer, { status: "loading" });

  useEffect(() => {
    let current = true;
    requestJson("/api/webroutes/account/me", { fallbackMessage: "Could not load your account." })
      .then((reply) => {
        if (current) dispatch({ type: "LOADED", user: readAccountProfile(reply) });
      })
      .catch((caught: unknown) => {
        if (current) {
          dispatch({
            type: "LOAD_FAILED",
            message: caught instanceof Error ? caught.message : "Could not load your account.",
          });
        }
      });
    return () => {
      current = false;
    };
  }, []);

  if (state.status === "loading") {
    return (
      <p role="status" className="text-sm text-white/70">
        Loading your account...
      </p>
    );
  }

  if (state.status === "failed") {
    return (
      <div className="space-y-3 rounded-3xl border border-white/15 bg-[#121721] p-6">
        <h1 className="text-xl font-black">Your account</h1>
        <p role="alert" className="text-sm text-rose-400">
          {state.message}
        </p>
        <button type="button" onClick={() => window.location.reload()} className={SECONDARY_BUTTON}>
          Try again
        </button>
      </div>
    );
  }

  if (state.status === "signed-out") {
    return (
      <div className="space-y-3 rounded-3xl border border-white/15 bg-[#121721] p-6" data-testid="account-signed-out">
        <h1 className="text-xl font-black">Sign in to manage your account</h1>
        <p className="text-sm text-white/70">Your profile, password and devices are here once you sign in.</p>
        <Link href={SIGN_IN_PATH} className={PRIMARY_BUTTON} style={{ backgroundColor: primaryFill(primaryHex) }}>
          Sign in
        </Link>
      </div>
    );
  }

  if (state.status === "ended") {
    const deleted = state.reason === "deleted";
    return (
      <div className="space-y-4 rounded-3xl border border-white/15 bg-[#121721] p-6" data-testid="account-ended">
        <CheckCircle2 className="h-8 w-8 text-emerald-400" aria-hidden="true" />
        <h1 className="text-xl font-black">
          {deleted ? "Your account was deleted" : "You're signed out everywhere"}
        </h1>
        <p className="text-sm leading-relaxed text-white/75">
          {deleted
            ? "Everything saved to it is gone. You can still browse and order on this device without an account."
            : "Every device, including this one, needs the password to sign in again."}
        </p>
        <Link
          href={deleted ? "/" : SIGN_IN_PATH}
          className={PRIMARY_BUTTON}
          style={{ backgroundColor: primaryFill(primaryHex) }}
        >
          {deleted ? "Back to KRAVE" : "Sign in"}
        </Link>
      </div>
    );
  }

  const { user } = state;
  return (
    <div className="space-y-5" data-testid="account-settings">
      <div className="space-y-1">
        <h1 className="text-2xl font-black">Your account</h1>
        <p className="text-sm text-white/70">
          Signed in as <span className="font-bold text-white">{user.displayName}</span>.{" "}
          <Link href="/" className="font-bold underline underline-offset-2">
            Back to KRAVE
          </Link>
        </p>
      </div>
      <ProfileSection
        key={user.id}
        user={user}
        primaryHex={primaryHex}
        onUpdated={(updated) => dispatch({ type: "USER_UPDATED", user: updated })}
      />
      <EmailSection user={user} primaryHex={primaryHex} />
      <PasswordSection primaryHex={primaryHex} />
      <DevicesSection
        primaryHex={primaryHex}
        onSignedOut={() => dispatch({ type: "ENDED", reason: "signed-out-everywhere" })}
      />
      <DeleteAccountSection onDeleted={() => dispatch({ type: "ENDED", reason: "deleted" })} />
    </div>
  );
}
