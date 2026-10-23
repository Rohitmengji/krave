import type { Metadata } from "next";
import { RestaurantOwnerDashboard } from "@/components/RestaurantOwnerDashboard";

export const metadata: Metadata = {
  title: "Restaurant workspace | KRAVE",
  robots: { index: false, follow: false },
};

export default function OwnerPage() {
  return <RestaurantOwnerDashboard />;
}
