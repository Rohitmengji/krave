import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@/components/ResetPasswordForm";
import { primaryFill } from "@/lib/themeContrast";

const BRAND_HEX = "#10B981";

export const metadata: Metadata = {
  title: "Choose a new password — KRAVE",
  description: "Set a new password for your KRAVE account.",
  robots: { index: false, follow: false },
  // The token is in the fragment, which is never sent; this also keeps the path private.
  referrer: "no-referrer",
};

export default function ResetPasswordPage() {
  return (
    <main data-surface="dark" className="min-h-dvh bg-[#0A0D12] px-4 py-8 text-white sm:py-16">
      <div className="mx-auto w-full max-w-md space-y-6">
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
        <section className="rounded-3xl border border-white/15 bg-[#121721] p-6 shadow-2xl">
          <ResetPasswordForm primaryHex={BRAND_HEX} />
        </section>
      </div>
    </main>
  );
}
