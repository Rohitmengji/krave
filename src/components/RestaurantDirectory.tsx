"use client";

import Link from "next/link";
import { ArrowRight, MapPin, Store } from "lucide-react";
import { primaryFill } from "@/lib/themeContrast";
import { searchRestaurants, type RestaurantListing } from "@/lib/restaurantDirectory";

interface RestaurantDirectoryProps {
  listing: RestaurantListing;
  query: string;
  onClearQuery: () => void;
  isDark: boolean;
  primaryHex: string;
}

export function RestaurantDirectory({
  listing,
  query,
  onClearQuery,
  isDark,
  primaryHex,
}: RestaurantDirectoryProps) {
  const panel = isDark ? "bg-[#121721] border-white/10" : "bg-white border-slate-200 shadow-sm";
  const restaurants = listing.status === "ready" ? listing.restaurants : [];
  const matches = searchRestaurants(restaurants, query);

  return (
    <section aria-labelledby="restaurant-directory-heading" className="space-y-4" data-testid="restaurant-directory">
      <div>
        <h2 id="restaurant-directory-heading" className="text-xl sm:text-2xl font-black tracking-tight">
          Restaurants on KRAVE
        </h2>
        <p className="text-xs opacity-70 mt-0.5">
          Every restaurant here was set up by its owner. Menus and prices come straight from them.
        </p>
      </div>

      {listing.status === "unavailable" ? (
        <div data-testid="restaurant-directory-error" role="alert" className={`p-8 rounded-3xl border space-y-3 ${panel}`}>
          <p className="font-bold">Restaurants could not be loaded right now.</p>
          <p className="text-sm opacity-75">Check your connection and try again.</p>
          {/* A full reload, so the server reads the list again. */}
          <a
            href="/"
            className="inline-flex min-h-11 items-center rounded-xl px-4 text-sm font-black text-white"
            style={{ backgroundColor: primaryFill(primaryHex) }}
          >
            Try again
          </a>
        </div>
      ) : restaurants.length === 0 ? (
        <div data-testid="restaurant-directory-empty" className={`p-8 sm:p-10 rounded-3xl border space-y-3 text-center ${panel}`}>
          <Store className="w-8 h-8 mx-auto opacity-60" aria-hidden="true" />
          <p className="font-black text-lg">No restaurants are live yet</p>
          <p className="text-sm opacity-75 max-w-lg mx-auto">
            KRAVE only lists restaurants whose owners have published their own menu, so there are no
            sample places, ratings or prices here.
          </p>
          <Link
            href="/owner"
            className="inline-flex min-h-11 items-center gap-2 rounded-xl px-4 text-sm font-black text-white"
            style={{ backgroundColor: primaryFill(primaryHex) }}
          >
            List your restaurant
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </Link>
        </div>
      ) : matches.length === 0 ? (
        <div className={`p-8 rounded-3xl border space-y-3 text-center ${panel}`}>
          <p className="font-bold">No restaurants match &ldquo;{query.trim()}&rdquo;</p>
          <button
            type="button"
            onClick={onClearQuery}
            className="min-h-11 rounded-xl px-4 text-sm font-black text-white"
            style={{ backgroundColor: primaryFill(primaryHex) }}
          >
            Clear search
          </button>
        </div>
      ) : (
        <ul className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {matches.map((restaurant) => (
            <li key={restaurant.slug} data-testid="restaurant-directory-item">
              <article
                className={`relative h-full rounded-3xl border p-5 space-y-3 transition hover:-translate-y-0.5 ${panel} ${
                  isDark ? "hover:border-white/25" : "hover:border-slate-300"
                }`}
              >
                <div className="flex items-start gap-3">
                  <span
                    aria-hidden="true"
                    className="w-12 h-12 shrink-0 rounded-2xl flex items-center justify-center text-lg font-black text-white"
                    style={{ backgroundColor: primaryFill(primaryHex) }}
                  >
                    {restaurant.name.slice(0, 1).toLocaleUpperCase()}
                  </span>
                  <div className="min-w-0">
                    <h3 className="font-black text-base leading-snug">
                      {/* The link covers the card, so the whole card is one target with one name. */}
                      <Link href={`/r/${restaurant.slug}`} className="after:absolute after:inset-0 after:rounded-3xl">
                        {restaurant.name}
                      </Link>
                    </h3>
                    {restaurant.address && (
                      <p className="text-xs opacity-70 mt-0.5 flex items-start gap-1">
                        <MapPin className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
                        <span>{restaurant.address}</span>
                      </p>
                    )}
                  </div>
                </div>
                {restaurant.description && <p className="text-sm opacity-80 line-clamp-2">{restaurant.description}</p>}
                <div className="flex flex-wrap items-center gap-2 text-[11px] font-bold">
                  {restaurant.services.map((service) => (
                    <span
                      key={service}
                      className={`px-2 py-1 rounded-lg border ${isDark ? "border-white/15" : "border-slate-300"}`}
                    >
                      {service}
                    </span>
                  ))}
                  <span className="ml-auto flex items-center gap-1" style={{ color: "var(--brand-ink)" }}>
                    {restaurant.acceptingOrders ? "Order online" : "View menu"}
                    <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                  </span>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
