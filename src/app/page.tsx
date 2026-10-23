import { KraveApp } from "@/components/KraveApp";
import { toRestaurantSummary, type RestaurantListing } from "@/lib/restaurantDirectory";
import { listPublishedRestaurants } from "@/lib/server/restaurantStore";

// The list is whatever owners have published at the moment of the request.
export const dynamic = "force-dynamic";

async function loadListing(): Promise<RestaurantListing> {
  try {
    const restaurants = await listPublishedRestaurants();
    return { status: "ready", restaurants: restaurants.map(toRestaurantSummary) };
  } catch (error) {
    console.error("[krave] Could not load published restaurants.", error);
    return { status: "unavailable" };
  }
}

export default async function HomePage() {
  return <KraveApp listing={await loadListing()} />;
}
