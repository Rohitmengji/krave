"use client";

import React from "react";
import {
  Bookmark,
  Clock,
  Sparkles,
  ShieldCheck,
  UtensilsCrossed,
  CalendarCheck,
  Leaf,
} from "lucide-react";
import {
  BrandThemePreset,
  DiscoveryTabKey,
  RestaurantEntity,
} from "@/types/krave";
import { FEE_SCHEDULE } from "@/lib/cartEngine";
import { primaryFill } from "@/lib/themeContrast";

interface RestaurantCardV2Props {
  restaurant: RestaurantEntity;
  activeMode: DiscoveryTabKey;
  theme: BrandThemePreset;
  isDark: boolean;
  isGoldMember: boolean;
  isBookmarked: boolean;
  onToggleBookmark: (resId: number) => void;
  onOpenRestaurant: (res: RestaurantEntity, initialTab?: "menu" | "book" | "reviews") => void;
}

export function RestaurantCardV2({
  restaurant,
  activeMode,
  theme,
  isDark,
  isGoldMember,
  isBookmarked,
  onToggleBookmark,
  onOpenRestaurant,
}: RestaurantCardV2Props) {
  const activeRating =
    activeMode === "delivery"
      ? restaurant.ratings.DELIVERY
      : restaurant.ratings.DINING;

  const secondaryRating =
    activeMode === "delivery"
      ? restaurant.ratings.DINING
      : restaurant.ratings.DELIVERY;

  const primaryOfferText =
    activeMode === "delivery" && restaurant.offers.length > 0
      ? restaurant.offers[0].title
      : restaurant.walkinOffer.title;

  return (
    <article
      data-testid={`restaurant-card-${restaurant.resId}`}
      className={`group rounded-3xl border overflow-hidden transition-all duration-300 hover:-translate-y-1 hover:shadow-2xl flex flex-col justify-between ${
        isDark
          ? "bg-[#121721] border-white/10 hover:border-white/25"
          : "bg-white border-slate-200 hover:border-slate-300 shadow-sm"
      }`}
    >
      {/* Top Media Banner */}
      <div>
        <div
          onClick={() =>
            onOpenRestaurant(
              restaurant,
              activeMode === "dineout" ? "book" : "menu"
            )
          }
          data-surface="dark"
          className="relative h-56 overflow-hidden cursor-pointer"
        >
          <img
            src={restaurant.heroImage}
            alt={restaurant.name}
            loading="lazy"
            decoding="async"
            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/25 to-transparent" />

          {/* Top Left Badges: Promoted + Pure Veg */}
          <div className="absolute top-3 left-3 flex items-center gap-2">
            {restaurant.isPromoted && (
              <span className="px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-black/65 backdrop-blur-md text-white/90 border border-white/15">
                Promoted
              </span>
            )}
            {restaurant.pureVeg && (
              <span className="px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-emerald-600/90 backdrop-blur-md text-white flex items-center gap-1">
                <Leaf className="w-3 h-3" /> Pure Veg
              </span>
            )}
          </div>

          {/* Bookmark Button */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggleBookmark(restaurant.resId);
            }}
            aria-label={`Bookmark ${restaurant.name}`}
            aria-pressed={isBookmarked}
            className={`absolute top-3 right-3 p-2 rounded-full backdrop-blur-md border transition ${
              isBookmarked
                ? "bg-amber-500 text-black border-amber-400"
                : "bg-black/50 text-white border-white/20 hover:bg-black/75"
            }`}
          >
            <Bookmark className="w-4 h-4 fill-current" />
          </button>

          {/* Bottom Offer Ribbon + ETA */}
          <div className="absolute bottom-3 left-3 right-3 flex items-end justify-between gap-2">
            <div className="space-y-1">
              <div
                className="inline-flex items-center gap-1.5 px-3 py-1 rounded-xl text-xs font-extrabold text-white shadow-lg"
                style={{ backgroundColor: primaryFill(theme.primaryHex) }}
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>{primaryOfferText}</span>
              </div>
              {isGoldMember && (
                <div className="text-[11px] font-bold text-amber-300 flex items-center gap-1 drop-shadow">
                  ★ +{restaurant.walkinOffer.goldExtraPercent}% Extra {theme.membershipName} Benefit
                </div>
              )}
            </div>

            <div className="px-2.5 py-1 rounded-xl bg-black/75 backdrop-blur-md text-white text-xs font-bold flex items-center gap-1 border border-white/15 shrink-0">
              <Clock className="w-3.5 h-3.5 text-emerald-400" />
              <span>
                {activeMode === "delivery"
                  ? restaurant.deliveryTimeText
                  : restaurant.distanceText}
              </span>
            </div>
          </div>
        </div>

        {/* Card Body */}
        <div className="p-4">
          <div className="flex items-start justify-between gap-2">
            <div
              onClick={() =>
                onOpenRestaurant(
                  restaurant,
                  activeMode === "dineout" ? "book" : "menu"
                )
              }
              className="cursor-pointer"
            >
              <h3 className="font-extrabold text-lg leading-snug group-hover:underline">
                {restaurant.name}
              </h3>
              <p className="text-xs opacity-65 truncate max-w-[240px] mt-0.5">
                {restaurant.cuisines.join(", ")}
              </p>
            </div>

            {/* Dual Rating Pill (Reconstructed from ratingNew.ratings) */}
            <div className="flex flex-col items-end shrink-0">
              <div
                className="px-2.5 py-1 rounded-xl text-white font-black text-xs flex items-center gap-1 shadow"
                style={{ backgroundColor: primaryFill(theme.primaryHex) }}
              >
                <span>{activeRating.rating}</span>
                <span>★</span>
              </div>
              <span className="text-[10px] opacity-70 mt-1 font-medium">
                {activeRating.rating_type} ({activeRating.reviewCount})
              </span>
            </div>
          </div>

          {/* Locality + Cost For Two */}
          <div className="mt-3 pt-3 border-t border-current/10 flex items-center justify-between text-xs opacity-75">
            <span className="truncate">{restaurant.locality}</span>
            <span className="font-bold shrink-0">{restaurant.costForTwoText}</span>
          </div>

          {/* Stated here so checkout cannot be the first time a fee is seen. */}
          <div
            data-testid={`fee-disclosure-${restaurant.resId}`}
            className="mt-1.5 text-[10px] opacity-70 leading-snug"
          >
            Plus ₹{FEE_SCHEDULE.platformFee} platform fee, ₹{FEE_SCHEDULE.deliveryFee} delivery (₹
            {FEE_SCHEDULE.reducedDeliveryFee} over ₹{FEE_SCHEDULE.reducedDeliveryOver}),{" "}
            {FEE_SCHEDULE.gstPercent}% GST and packaging from ₹{FEE_SCHEDULE.packagingPerItem}.
          </div>

          {/* Hygiene & Secondary Rating Metadata */}
          <div className="mt-2.5 flex items-center justify-between text-[11px] opacity-80">
            <span className="flex items-center gap-1 text-emerald-400 font-medium">
              <ShieldCheck className="w-3.5 h-3.5" />
              Hygiene {restaurant.hygieneRating.split(" ")[0]}
            </span>
            <span>
              {secondaryRating.rating_type}: ★ {secondaryRating.rating}
            </span>
          </div>
        </div>
      </div>

      {/* Dual Action Footer: Order Online vs Book Table */}
      <div className="px-4 pb-4 pt-1 grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => onOpenRestaurant(restaurant, "menu")}
          data-testid={`open-menu-${restaurant.resId}`}
          className="flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl text-xs font-bold text-white transition hover:opacity-95 shadow-sm"
          style={{ backgroundColor: primaryFill(theme.primaryHex) }}
        >
          <UtensilsCrossed className="w-3.5 h-3.5" />
          <span>Order Menu</span>
        </button>
        <button
          type="button"
          onClick={() => onOpenRestaurant(restaurant, "book")}
          data-testid={`book-table-${restaurant.resId}`}
          className={`flex items-center justify-center gap-1.5 py-2.5 px-3 rounded-xl text-xs font-bold border transition ${
            isDark
              ? "bg-white/5 border-white/15 hover:bg-white/10 text-white"
              : "bg-slate-100 border-slate-200 hover:bg-slate-200 text-slate-900"
          }`}
        >
          <CalendarCheck className="w-3.5 h-3.5" style={{ color: "var(--brand-ink)" }} />
          <span>Book Table</span>
        </button>
      </div>
    </article>
  );
}
