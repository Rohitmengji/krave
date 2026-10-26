import { describe, expect, it } from "vitest";
import { searchRestaurants, toRestaurantSummary, type RestaurantSummary } from "@/lib/restaurantDirectory";
import type { ManagedRestaurant } from "@/lib/server/restaurantStore";

function restaurant(overrides: Partial<ManagedRestaurant> = {}): ManagedRestaurant {
  return {
    id: "rst_1",
    ownerUserId: "usr_owner",
    slug: "jagadamba-maratha-khanawali",
    name: "Jagadamba Maratha Khanawali",
    description: "Maratha khanawali serving biryanis.",
    phone: "+91 90000 00000",
    email: "owner@example.com",
    address: "Yadgir Main Road, near Kismat Talkies",
    city: "Wadi",
    state: "Karnataka",
    postalCode: "585225",
    serviceAreas: [],
    deliveryEnabled: false,
    takeawayEnabled: true,
    dineInEnabled: true,
    minimumOrderPaise: 0,
    deliveryFeePaise: 0,
    taxRateBps: 0,
    taxEnabled: false,
    acceptingOrders: false,
    timeZone: "Asia/Kolkata",
    fssaiNumber: "",
    gstin: "",
    status: "published",
    createdAt: "2026-10-23T00:00:00.000Z",
    updatedAt: "2026-10-23T00:00:00.000Z",
    publishedAt: "2026-10-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("storefront restaurant directory", () => {
  it("lists only what the owner published, with no contact or account details", () => {
    const summary = toRestaurantSummary(restaurant());
    expect(summary).toEqual({
      slug: "jagadamba-maratha-khanawali",
      name: "Jagadamba Maratha Khanawali",
      description: "Maratha khanawali serving biryanis.",
      address: "Yadgir Main Road, near Kismat Talkies, Wadi, Karnataka",
      services: ["Dine-in", "Takeaway"],
      acceptingOrders: false,
    });
    expect(JSON.stringify(summary)).not.toMatch(/usr_owner|owner@example\.com|90000/);
  });

  it("leaves out empty address parts and services that are switched off", () => {
    const summary = toRestaurantSummary(
      restaurant({ address: "", state: "", dineInEnabled: false, takeawayEnabled: false, deliveryEnabled: true })
    );
    expect(summary.address).toBe("Wadi");
    expect(summary.services).toEqual(["Delivery"]);
  });

  it("matches name, place or description, ignoring case and surrounding spaces", () => {
    const listed: RestaurantSummary[] = [
      toRestaurantSummary(restaurant()),
      toRestaurantSummary(
        restaurant({ slug: "udupi-upahar", name: "Udupi Upahar", description: "Dosa and filter coffee.", city: "Kalaburagi" })
      ),
    ];
    const names = (query: string) => searchRestaurants(listed, query).map((entry) => entry.name);

    expect(names("")).toEqual(["Jagadamba Maratha Khanawali", "Udupi Upahar"]);
    expect(names("   ")).toHaveLength(2);
    expect(names("  JAGADAMBA ")).toEqual(["Jagadamba Maratha Khanawali"]);
    expect(names("kalaburagi")).toEqual(["Udupi Upahar"]);
    expect(names("biryani")).toEqual(["Jagadamba Maratha Khanawali"]);
    expect(names("pizza")).toEqual([]);
  });

  it("finds names written in a regional script", () => {
    const listed = [toRestaurantSummary(restaurant({ name: "ಜಗದಂಬಾ ಮರಾಠಾ ಖಾನಾವಳಿ" }))];
    expect(searchRestaurants(listed, "ಜಗದಂಬಾ")).toHaveLength(1);
  });
});
