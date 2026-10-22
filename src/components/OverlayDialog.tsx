"use client";

import React, { useEffect, useEffectEvent, useRef } from "react";

/**
 * Wraps content in a native dialog so the browser supplies focus containment and the
 * top layer, matching how checkout and tracking already behave.
 */
export function OverlayDialog({
  isOpen,
  onClose,
  label,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  label: string;
  children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const handleClose = useEffectEvent(() => onClose());
  // Some browsers do not raise the dialog's own cancel event, so Escape is also handled
  // explicitly here, the same way the checkout and tracking dialogs do it.
  const handleEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    onClose();
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || !dialog) return;
    if (!dialog.open) dialog.showModal();
    dialog.addEventListener("close", handleClose);
    document.addEventListener("keydown", handleEscape, true);
    return () => {
      dialog.removeEventListener("close", handleClose);
      document.removeEventListener("keydown", handleEscape, true);
      if (dialog.open) dialog.close();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <dialog
      ref={dialogRef}
      aria-label={label}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      className="m-auto w-full max-w-lg bg-transparent p-4 backdrop:bg-black/80"
    >
      {children}
    </dialog>
  );
}
