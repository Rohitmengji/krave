"use client";

import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { OverlayDialog } from "./OverlayDialog";
import { primaryFill } from "@/lib/themeContrast";

export type ConfirmTone = "default" | "danger";

const DEFAULT_PRIMARY = "#10B981";

export interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** "danger" for anything that cannot be undone. */
  tone?: ConfirmTone;
  /** While the confirmed action runs: buttons are disabled and the dialog stays open. */
  busy?: boolean;
  busyLabel?: string;
  error?: string | null;
  confirmDisabled?: boolean;
  isDark?: boolean;
  primaryHex?: string;
  testId?: string;
  /** Extra fields, such as a password, between the explanation and the buttons. */
  children?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

/** The app's one confirmation, in place of the browser's confirm(): styled, focus-safe, labelled. */
export function ConfirmDialog({
  isOpen,
  title,
  busy = false,
  onCancel,
  testId = "confirm-dialog",
  ...panel
}: ConfirmDialogProps) {
  const descriptionId = useId();
  return (
    <OverlayDialog
      isOpen={isOpen}
      onClose={onCancel}
      onDismiss={() => {
        if (!busy) onCancel();
      }}
      label={title}
      role="alertdialog"
      describedBy={descriptionId}
      testId={testId}
    >
      <ConfirmPanel
        {...panel}
        title={title}
        busy={busy}
        onCancel={onCancel}
        descriptionId={descriptionId}
      />
    </OverlayDialog>
  );
}

function ConfirmPanel({
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  tone = "default",
  busy,
  busyLabel = "Working...",
  error = null,
  confirmDisabled = false,
  isDark = true,
  primaryHex = DEFAULT_PRIMARY,
  children,
  onConfirm,
  onCancel,
  descriptionId,
}: Omit<ConfirmDialogProps, "isOpen" | "testId" | "busy"> & { busy: boolean; descriptionId: string }) {
  const panelRef = useRef<HTMLFormElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const errorId = useId();

  useEffect(() => {
    // After the dialog opens. A field to fill takes focus; otherwise the safe choice does.
    const firstField = panelRef.current?.querySelector<HTMLElement>("input, select, textarea");
    (firstField ?? cancelRef.current)?.focus();
  }, []);

  const surface = isDark
    ? "bg-[#121721] border-white/15 text-white"
    : "bg-white border-slate-200 text-slate-900";
  const danger = tone === "danger";

  return (
    <form
      ref={panelRef}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && !confirmDisabled) onConfirm();
      }}
      className={`space-y-4 rounded-3xl border p-6 shadow-2xl ${surface}`}
    >
      <div className="flex items-start gap-3">
        {danger && (
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-rose-500/15 text-rose-400">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </span>
        )}
        <div className="min-w-0 space-y-1.5">
          <h2 className="text-base font-black">{title}</h2>
          <div id={descriptionId} className="text-sm leading-relaxed opacity-80">
            {description}
          </div>
        </div>
      </div>

      {children}

      {error && (
        <p id={errorId} role="alert" className="text-sm text-rose-400">
          {error}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <button
          ref={cancelRef}
          type="button"
          data-testid="confirm-cancel"
          onClick={onCancel}
          disabled={busy}
          className="min-h-11 w-full rounded-2xl border border-current/20 px-5 text-sm font-bold disabled:opacity-50 sm:w-auto"
        >
          {cancelLabel}
        </button>
        <button
          type="submit"
          data-testid="confirm-accept"
          disabled={busy || confirmDisabled}
          aria-busy={busy}
          aria-describedby={error ? errorId : undefined}
          className={`min-h-11 w-full rounded-2xl px-5 text-sm font-black text-white disabled:opacity-50 sm:w-auto ${
            danger ? "bg-rose-600 hover:bg-rose-700" : ""
          }`}
          style={danger ? undefined : { backgroundColor: primaryFill(primaryHex) }}
        >
          {busy ? busyLabel : confirmLabel}
        </button>
      </div>
    </form>
  );
}

export interface ConfirmRequest {
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  /** Name the safe choice when "Cancel" would be ambiguous, e.g. "Keep order". */
  cancelLabel?: string;
  tone?: ConfirmTone;
}

/**
 * `await confirm({...})` in place of window.confirm. Render `dialog` once; a newer question
 * replaces one still open, which then counts as declined.
 */
export function useConfirm({
  isDark,
  primaryHex,
}: { isDark?: boolean; primaryHex?: string } = {}): [
  (request: ConfirmRequest) => Promise<boolean>,
  React.ReactNode,
] {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const pending = useRef<((confirmed: boolean) => void) | null>(null);

  const settle = useCallback((confirmed: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(confirmed);
  }, []);

  const confirm = useCallback((next: ConfirmRequest) => {
    pending.current?.(false);
    return new Promise<boolean>((resolve) => {
      pending.current = resolve;
      setRequest(next);
    });
  }, []);

  // A question still open when the page goes away is declined, so no caller hangs forever.
  useEffect(
    () => () => {
      pending.current?.(false);
      pending.current = null;
    },
    []
  );

  const dialog = (
    <ConfirmDialog
      isOpen={request !== null}
      title={request?.title ?? ""}
      description={request?.description}
      confirmLabel={request?.confirmLabel ?? "Confirm"}
      cancelLabel={request?.cancelLabel}
      tone={request?.tone}
      isDark={isDark}
      primaryHex={primaryHex}
      onConfirm={() => settle(true)}
      onCancel={() => settle(false)}
    />
  );
  return [confirm, dialog];
}
