import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { KraveApp } from "@/components/KraveApp";
import { RESTAURANTS_DATA } from "@/data/zomatoReconstructedData";
import { findRestaurantByParam } from "@/lib/restaurantRoute";

// The menu is static data, so every real page is generated at build time; anything
// else is a 404 rather than an on-demand render.
export const dynamicParams = false;

export function generateStaticParams() {
  return RESTAURANTS_DATA.map((restaurant) => ({ resId: String(restaurant.resId) }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ resId: string }>;
}): Promise<Metadata> {
  const { resId } = await params;
  const restaurant = findRestaurantByParam(resId);
  if (!restaurant) return { title: "Restaurant not found — KRAVE" };

  return {
    title: `${restaurant.name} — ${restaurant.locality} | KRAVE`,
    description: `${restaurant.cuisines.join(", ")} in ${restaurant.locality}. ${restaurant.walkinOffer.title}. Demo menu and demo checkout only.`,
    openGraph: {
      title: `${restaurant.name} — KRAVE`,
      description: `${restaurant.cuisines.join(", ")} · ${restaurant.costForTwoText}`,
      images: restaurant.heroImage ? [restaurant.heroImage] : undefined,
    },
  };
}

export default async function RestaurantPage({
  params,
}: {
  params: Promise<{ resId: string }>;
}) {
  const { resId } = await params;
  const restaurant = findRestaurantByParam(resId);
  if (!restaurant) notFound();

  return <KraveApp initialRestaurantId={restaurant.resId} />;
}
