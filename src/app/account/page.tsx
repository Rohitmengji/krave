import type { Metadata } from "next";
import { AccountSettings } from "@/components/account/AccountSettings";
import { BRAND_HEX, StandalonePage } from "@/components/StandalonePage";

export const metadata: Metadata = {
  title: "Your account — KRAVE",
  description: "Manage your KRAVE profile, email address, password and devices.",
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  return (
    <StandalonePage wide>
      <AccountSettings primaryHex={BRAND_HEX} />
    </StandalonePage>
  );
}
