"use client";

import React, { useEffectEvent, useLayoutEffect, useRef } from "react";

const CENTRED_PANEL = "m-auto w-full max-w-lg bg-transparent p-4 backdrop:bg-black/80";

/**
 * Covers the viewport with the dialog itself, for overlays that draw their own scrim and
 * scroll a tall panel. Pair with `open:flex items-center justify-center` and a `my-auto`
 * panel; `open:` keeps the browser's display:none while the dialog is closed.
 */
export const FULL_SCREEN_DIALOG =
  "fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none overflow-y-auto overscroll-contain border-0 backdrop:bg-transparent";

/**
 * The one modal primitive. A native dialog opened with showModal() gives the top layer,
 * focus containment and an inert page behind it, so Tab cannot reach the navbar.
 *
 * Dismissal is stack-aware with no document listener: Escape is handled on the dialog
 * that holds focus, and the browser's own cancel goes only to the topmost modal, so one
 * Escape closes one layer.
 */
type OverlayDialogProps = {
  isOpen: boolean;
  /** Called when the dialog must close, including when the browser closed it itself. */
  onClose: () => void;
  /**
   * Escape, a back gesture or a backdrop click. Defaults to onClose. An owner that must
   * stay open (payment in flight) can decline by not closing; the dialog stays up.
   */
  onDismiss?: () => void;
  label: string;
  className?: string;
  testId?: string;
  closeOnBackdrop?: boolean;
  children: React.ReactNode;
};

export function OverlayDialog({ isOpen, ...props }: OverlayDialogProps) {
  // Closing must unmount OpenDialog, not re-render it. React removes a re-rendered
  // component's deleted children before running its layout cleanup, so close() would hit
  // a detached dialog and focus would fall to <body>. A deleted component runs its
  // cleanup first, while the dialog is still connected.
  return isOpen ? <OpenDialog {...props} /> : null;
}

function OpenDialog({
  onClose,
  onDismiss = onClose,
  label,
  className = CENTRED_PANEL,
  testId,
  closeOnBackdrop = true,
  children,
}: Omit<OverlayDialogProps, "isOpen">) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const pressStartedOnBackdrop = useRef(false);
  const dismiss = useEffectEvent(() => onDismiss());

  // A layout effect, so the dialog is in the top layer before first paint and is closed
  // while still in the document, which lets the browser return focus to its opener.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    let reopenFrame = 0;
    const handleCancel = (event: Event) => {
      event.preventDefault();
      dismiss();
    };
    // Without recent user activation the browser skips cancel and closes outright. That
    // is still only a request: if the owner kept the dialog, show it again.
    const handleClose = () => {
      // A close queued by an earlier cleanup (Strict Mode remount) lands after reopening.
      if (dialog.open) return;
      dismiss();
      reopenFrame = requestAnimationFrame(() => {
        if (dialog.isConnected && !dialog.open) dialog.showModal();
      });
    };
    dialog.addEventListener("cancel", handleCancel);
    dialog.addEventListener("close", handleClose);
    return () => {
      cancelAnimationFrame(reopenFrame);
      dialog.removeEventListener("cancel", handleCancel);
      dialog.removeEventListener("close", handleClose);
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-label={label}
      data-testid={testId}
      onKeyDown={(event) => {
        // Composition Escape (IME) and keys a child already handled are not dismissals.
        if (event.key !== "Escape" || event.nativeEvent.isComposing || event.defaultPrevented) return;
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
      }}
      // Both ends of the press must be on the backdrop: a text selection dragged out of
      // the panel ends with a click on the dialog and must not close it.
      onPointerDown={(event) => {
        pressStartedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        const fromBackdrop = pressStartedOnBackdrop.current && event.target === event.currentTarget;
        pressStartedOnBackdrop.current = false;
        if (closeOnBackdrop && fromBackdrop) onDismiss();
      }}
      className={className}
    >
      {children}
    </dialog>
  );
}
