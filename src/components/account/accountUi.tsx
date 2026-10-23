import React, { useId } from "react";
import type { SectionState } from "@/lib/accountRules";

export const FIELD =
  "w-full rounded-xl border border-white/15 bg-[#0E131D] px-3 py-2.5 text-sm text-white placeholder:text-white/40";
export const SECONDARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-2xl border border-white/20 px-4 text-sm font-bold disabled:opacity-50";
export const PRIMARY_BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-2xl px-5 text-sm font-black text-white disabled:opacity-50";

export function Section({
  title,
  description,
  testId,
  danger = false,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  testId: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      data-testid={testId}
      className={`space-y-4 rounded-3xl border bg-[#121721] p-5 sm:p-6 ${
        danger ? "border-rose-500/40" : "border-white/15"
      }`}
    >
      <div className="space-y-1">
        <h2 id={headingId} className="text-base font-black">
          {title}
        </h2>
        {description && <p className="text-sm leading-relaxed text-white/70">{description}</p>}
      </div>
      {children}
    </section>
  );
}

/** The outcome of a section's last save: an error is an alert, a success a polite status. */
export function SectionOutcome({ state, errorId }: { state: SectionState; errorId: string }) {
  if (state.status !== "editing") return null;
  if (state.error) {
    return (
      <p id={errorId} role="alert" className="text-sm text-rose-400">
        {state.error}
      </p>
    );
  }
  return (
    <p role="status" className="text-sm text-emerald-400">
      {state.notice ?? ""}
    </p>
  );
}

export function errorText(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}
