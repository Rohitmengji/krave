import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ManagedOrderStatus } from "@/components/ManagedOrderStatus";
import { getPublicRestaurantOrder } from "@/lib/server/restaurantOrderStore";

export const dynamic = "force-dynamic";

// The URL is the customer's private link to their order.
export const metadata: Metadata = {
  title: "Your order",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type OrderPageProps = { params: Promise<{ slug: string; orderId: string }> };

export default async function OrderStatusPage({ params }: OrderPageProps) {
  const { slug, orderId } = await params;
  const order = await getPublicRestaurantOrder(orderId);
  if (!order || order.restaurant.slug !== slug) notFound();
  return (
    <main className="min-h-screen bg-[#f7f5ef] px-4 py-8 text-[#1d2922]">
      <div className="mx-auto max-w-2xl">
        <ManagedOrderStatus initialOrder={order} />
      </div>
    </main>
  );
}
