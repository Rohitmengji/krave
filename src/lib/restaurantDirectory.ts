import type { ManagedRestaurant } from "@/lib/server/restaurantStore";

/** What the storefront lists about a published restaurant: only what its owner entered. */
export interface RestaurantSummary {
  slug: string;
  name: string;
  description: string;
  address: string;
  services: ("Dine-in" | "Takeaway" | "Delivery")[];
  acceptingOrders: boolean;
}

export type RestaurantListing =
  | { status: "ready"; restaurants: RestaurantSummary[] }
  | { status: "unavailable" };

export function toRestaurantSummary(restaurant: ManagedRestaurant): RestaurantSummary {
  const services: RestaurantSummary["services"] = [];
  if (restaurant.dineInEnabled) services.push("Dine-in");
  if (restaurant.takeawayEnabled) services.push("Takeaway");
  if (restaurant.deliveryEnabled) services.push("Delivery");
  return {
    slug: restaurant.slug,
    name: restaurant.name,
    description: restaurant.description,
    address: [restaurant.address, restaurant.city, restaurant.state].filter(Boolean).join(", "),
    services,
    acceptingOrders: restaurant.acceptingOrders,
  };
}

/** Restaurants whose name, place or description contains the query, in their listed order. */
export function searchRestaurants(
  restaurants: readonly RestaurantSummary[],
  query: string
): RestaurantSummary[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [...restaurants];
  return restaurants.filter((restaurant) =>
    [restaurant.name, restaurant.address, restaurant.description].some((field) =>
      field.toLocaleLowerCase().includes(needle)
    )
  );
}
