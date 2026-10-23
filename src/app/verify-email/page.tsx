import type { Metadata } from "next";
import { VerifyEmailConfirm } from "@/components/VerifyEmailConfirm";
import { BRAND_HEX, StandalonePage } from "@/components/StandalonePage";

export const metadata: Metadata = {
  title: "Confirm your email — KRAVE",
  description: "Confirm the email address on your KRAVE account.",
  robots: { index: false, follow: false },
  // The token is in the fragment, which is never sent; this also keeps the path private.
  referrer: "no-referrer",
};

export default function VerifyEmailPage() {
  return (
    <StandalonePage>
      <section className="rounded-3xl border border-white/15 bg-[#121721] p-6 shadow-2xl">
        <VerifyEmailConfirm primaryHex={BRAND_HEX} />
      </section>
    </StandalonePage>
  );
}
