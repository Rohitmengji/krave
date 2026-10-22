import type { Metadata } from "next";
import { KraveApp } from "@/components/KraveApp";

export const metadata: Metadata = {
  title: "Your Orders & Table Bookings — KRAVE",
  description: "Demo order history and table reservations saved on this device.",
  // The page only ever renders this browser's own local history.
  robots: { index: false, follow: false },
};

export default function OrdersPage() {
  return <KraveApp initialView="orders" />;
}
