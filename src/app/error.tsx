"use client";

import React from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="min-h-screen bg-[#0A0D12] text-white flex items-center justify-center p-6">
      <div className="max-w-md w-full rounded-3xl border border-white/15 bg-[#121721] p-6 space-y-4 text-center shadow-2xl">
        <h2 className="text-xl font-black">Something went wrong</h2>
        <p className="text-xs text-white/70 leading-relaxed">
          {error.message || "An unexpected error occurred while rendering this view."}
        </p>
        <button
          type="button"
          onClick={reset}
          className="px-5 py-2.5 rounded-xl text-xs font-black bg-emerald-500 text-white hover:bg-emerald-600 transition"
        >
          Try Again
        </button>
      </div>
    </div>
  );
}
