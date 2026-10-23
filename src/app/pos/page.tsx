import type { Metadata } from "next";
import { PosTerminal } from "@/components/pos/PosTerminal";

export const metadata: Metadata = {
  title: "Dine-In Billing Terminal",
  description:
    "Offline point-of-sale terminal for table service: take orders, fire kitchen tickets, calculate GST bills and settle payments.",
  // A staff tool: nothing here is for search results.
  robots: { index: false, follow: false },
};

export default function PosPage() {
  return <PosTerminal />;
}
