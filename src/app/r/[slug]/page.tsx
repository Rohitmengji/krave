import { cache } from "react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ManagedMenuOrdering, type MenuDisplayCategory } from "@/components/ManagedMenuOrdering";
import { orderingState } from "@/lib/server/restaurantOrderStore";
import {
  getManagedMenu,
  getOpeningHours,
  getPublishedRestaurantBySlug,
} from "@/lib/server/restaurantStore";

// Opening hours and availability are evaluated per request.
export const dynamic = "force-dynamic";

type RestaurantPageProps = {
  params: Promise<{ slug: string }>;
};

// The metadata and the page read the same restaurant once per request.
const publishedRestaurant = cache(getPublishedRestaurantBySlug);

/** What a shared link shows on WhatsApp and in the browser tab: this restaurant, not KRAVE. */
export async function generateMetadata({ params }: RestaurantPageProps): Promise<Metadata> {
  const restaurant = await publishedRestaurant((await params).slug);
  if (!restaurant) return { title: "Menu not found · KRAVE" };
  const title = `${restaurant.name} — Menu and prices`;
  const description = (
    restaurant.description.trim() ||
    `The menu and prices of ${restaurant.name}${restaurant.city ? `, ${restaurant.city}` : ""}, published by the restaurant itself.`
  ).slice(0, 160);
  return { title, description, openGraph: { title, description, type: "website" } };
}

function formatRupees(paise: number): string {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 2,
  }).format(paise / 100);
}

export default async function RestaurantPage({ params }: RestaurantPageProps) {
  const { slug } = await params;
  const restaurant = await publishedRestaurant(slug);
  if (!restaurant) notFound();
  const [categories, hours] = await Promise.all([
    getManagedMenu("", restaurant.id, true),
    getOpeningHours(restaurant.id),
  ]);
  const ordering = orderingState(restaurant, hours);
  // Only what the public page needs crosses to the client: no revisions, import ids or flags.
  const displayCategories: MenuDisplayCategory[] = categories.map((category) => ({
    id: category.id,
    name: category.name,
    items: category.items.map((item) => ({
      id: item.id,
      name: item.name,
      description: item.description,
      portionSize: item.portionSize,
      pricePaise: item.pricePaise,
      discountedPricePaise: item.discountedPricePaise,
      imageUrl: item.imageAssetId
        ? `/api/public/restaurants/${encodeURIComponent(restaurant.slug)}/assets/${encodeURIComponent(item.imageAssetId)}`
        : null,
      variants: item.variants.map(({ id, name, priceDeltaPaise }) => ({ id, name, priceDeltaPaise })),
      addons: item.addons.map(({ id, name, pricePaise }) => ({ id, name, pricePaise })),
    })),
  }));

  return (
    <main className="min-h-screen bg-[#f7f5ef] text-[#1d2922]">
      <header className="border-b border-[#d9ded7] bg-white">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-4 px-5 py-6">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.22em] text-emerald-800">
              Official menu
            </p>
            <h1 className="mt-2 text-3xl font-black tracking-tight sm:text-4xl">
              {restaurant.name}
            </h1>
            <p className="mt-2 text-sm text-slate-600">
              {[restaurant.address, restaurant.city, restaurant.state, restaurant.postalCode]
                .filter(Boolean)
                .join(", ")}
            </p>
          </div>
          {restaurant.phone ? (
            <a
              href={`tel:${restaurant.phone}`}
              className="rounded-xl bg-emerald-800 px-5 py-3 font-bold text-white hover:bg-emerald-700"
            >
              Call to order
            </a>
          ) : null}
        </div>
      </header>

      <div className="mx-auto max-w-5xl space-y-8 px-5 py-8">
        {restaurant.description ? (
          <p className="max-w-3xl text-slate-700">{restaurant.description}</p>
        ) : null}
        <p className="text-sm text-slate-600">
          {[
            restaurant.dineInEnabled ? "Dine-in" : null,
            restaurant.takeawayEnabled ? "Takeaway" : null,
            restaurant.deliveryEnabled ? "Delivery" : null,
          ]
            .filter(Boolean)
            .join(" · ")}
          {restaurant.minimumOrderPaise > 0
            ? ` · Minimum order ${formatRupees(restaurant.minimumOrderPaise)}`
            : ""}
          {restaurant.deliveryEnabled && restaurant.deliveryFeePaise > 0
            ? ` · Delivery fee ${formatRupees(restaurant.deliveryFeePaise)}`
            : ""}
        </p>

        {categories.length === 0 ? (
          <section className="rounded-2xl border border-amber-300 bg-amber-50 p-6">
            <h2 className="text-xl font-bold">Menu is being updated</h2>
            <p className="mt-2 text-slate-700">
              Please call the restaurant to check today&apos;s menu and availability.
            </p>
          </section>
        ) : (
          <ManagedMenuOrdering
            slug={restaurant.slug}
            restaurantName={restaurant.name}
            restaurantPhone={restaurant.phone}
            closedReason={ordering.reason}
            charges={{
              minimumOrderPaise: restaurant.minimumOrderPaise,
              deliveryFeePaise: restaurant.deliveryFeePaise,
              taxEnabled: restaurant.taxEnabled,
              taxRateBps: restaurant.taxRateBps,
              serviceAreas: restaurant.serviceAreas,
              fulfilments: ordering.fulfilments,
            }}
            categories={displayCategories}
          />
        )}
        <p className="text-xs text-slate-600">
          Contact the restaurant about allergens or dietary requirements; menu information may be incomplete.
        </p>
      </div>
    </main>
  );
}
