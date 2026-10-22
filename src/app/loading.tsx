import React from "react";

export default function Loading() {
  return (
    <div
      role="status"
      aria-label="Loading kitchens and menus"
      className="min-h-screen bg-[#0A0D12] text-white p-6 sm:p-10 space-y-6"
    >
      <div className="max-w-7xl mx-auto space-y-6 animate-pulse">
        <div className="h-16 rounded-2xl bg-white/5 border border-white/10" />
        <div className="h-44 rounded-3xl bg-white/5 border border-white/10" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="h-72 rounded-3xl bg-white/5 border border-white/10" />
          <div className="h-72 rounded-3xl bg-white/5 border border-white/10" />
          <div className="h-72 rounded-3xl bg-white/5 border border-white/10" />
        </div>
      </div>
    </div>
  );
}
