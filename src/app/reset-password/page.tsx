import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/ResetPasswordForm";
import { BRAND_HEX, StandalonePage } from "@/components/StandalonePage";

export const metadata: Metadata = {
  title: "Choose a new password — KRAVE",
  description: "Set a new password for your KRAVE account.",
  robots: { index: false, follow: false },
  // The token is in the fragment, which is never sent; this also keeps the path private.
  referrer: "no-referrer",
};

export default function ResetPasswordPage() {
  return (
    <StandalonePage>
      <section className="rounded-3xl border border-white/15 bg-[#121721] p-6 shadow-2xl">
        <ResetPasswordForm primaryHex={BRAND_HEX} />
      </section>
    </StandalonePage>
  );
}
