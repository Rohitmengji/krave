"use client";

import React, { useLayoutEffect, useRef } from "react";
import { CheckCircle2 } from "lucide-react";
import { announce } from "@/lib/announcer";

/**
 * A manual popover, so the toast sits in the top layer above any open modal dialog; a
 * plain fixed element would be painted under the dialog's backdrop. Mount one per
 * message (key it) so each is shown fresh on top of whatever opened before it.
 *
 * The visual is hidden from assistive tech: an open modal makes it inert anyway. The
 * message is spoken through the announcer, which targets the topmost dialog.
 */
export function Toast({ message }: { message: string }) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const element = ref.current;
    // Browsers without popover support render it as the fixed element it already is.
    if (element && typeof element.showPopover === "function") element.showPopover();
    announce(message);
  }, [message]);

  return (
    <div
      ref={ref}
      popover="manual"
      aria-hidden="true"
      className="fixed inset-auto bottom-24 right-6 m-0 pointer-events-none z-50 px-4 py-3 rounded-2xl bg-emerald-600 text-white text-xs font-extrabold shadow-2xl flex items-center gap-2 border border-white/20"
    >
      <CheckCircle2 className="w-4 h-4" />
      <span>{message}</span>
    </div>
  );
}
