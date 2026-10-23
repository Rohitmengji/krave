import Link from "next/link";
import React from "react";
import { primaryFill } from "@/lib/themeContrast";

export const BRAND_HEX = "#10B981";

/** The frame for pages reached from email links and settings: brand mark and one column. */
export function StandalonePage({
  wide = false,
  children,
}: {
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <main data-surface="dark" className="min-h-dvh bg-[#0A0D12] px-4 py-8 text-white sm:py-16">
      <div className={`mx-auto w-full space-y-6 ${wide ? "max-w-2xl" : "max-w-md"}`}>
        <Link href="/" className="inline-flex items-center gap-3 text-xl font-black tracking-tight">
          <span
            aria-hidden="true"
            className="grid h-10 w-10 place-items-center rounded-2xl text-lg text-white"
            style={{ backgroundColor: primaryFill(BRAND_HEX) }}
          >
            K
          </span>
          KRAVE
        </Link>
        {children}
      </div>
    </main>
  );
}
