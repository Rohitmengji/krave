"use client";

import { useEffect } from "react";

function digestOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("digest" in error)) return null;
  const { digest } = error as { digest?: unknown };
  return typeof digest === "string" && digest ? digest : null;
}

export default function GlobalError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  // The raw message is never shown: a client-side throw can carry internals, and a server
  // error is already masked by Next. The digest matches the server log entry.
  const digest = digestOf(error);

  return (
    <div className="min-h-screen bg-[#0A0D12] text-white flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-3xl border border-white/15 bg-[#121721] p-6 space-y-4 text-center shadow-2xl">
        <h2 className="text-xl font-black">Something went wrong</h2>
        <p className="text-xs text-white/70 leading-relaxed">
          This view hit an unexpected error. Please try again.
        </p>
        {digest && <p className="text-[10px] text-white/40 font-mono">Reference: {digest}</p>}
        <button
          type="button"
          onClick={() => retry()}
          className="px-5 py-2.5 rounded-xl text-xs font-black bg-emerald-500 text-white hover:bg-emerald-600 transition"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
