"use client";

import React, { useState } from "react";
import Link from "next/link";
import {
  Search,
  Palette,
  Sun,
  Moon,
  X,
  Bell,
  Bike,
  Utensils,
  UserRound,
  Receipt,
} from "lucide-react";
import { BrandThemePreset, DishItem, RestaurantEntity } from "@/types/krave";
import { primaryFill } from "@/lib/themeContrast";

interface NavbarProps {
  theme: BrandThemePreset;
  isDark: boolean;
  onToggleDark: () => void;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  restaurants: RestaurantEntity[];
  onSelectRestaurant: (res: RestaurantEntity, initialTab?: "menu" | "book" | "reviews") => void;
  onQuickAddDish: (res: RestaurantEntity, dish: DishItem) => void;
  onOpenBrandStudio: () => void;
  hasActiveOrder: boolean;
  onOpenActiveOrder: () => void;
  activeOrderPillRef?: React.Ref<HTMLButtonElement>;
  onOpenInbox: () => void;
  unreadCount: number;
  accountName: string | null;
  onOpenAccount: () => void;
}

export function Navbar({
  theme,
  isDark,
  onToggleDark,
  searchQuery,
  onSearchChange,
  restaurants,
  onSelectRestaurant,
  onQuickAddDish,
  onOpenBrandStudio,
  hasActiveOrder,
  onOpenActiveOrder,
  activeOrderPillRef,
  onOpenInbox,
  unreadCount,
  accountName,
  onOpenAccount,
}: NavbarProps) {
  const [searchFocused, setSearchFocused] = useState(false);

  const normalizedQuery = searchQuery.trim().toLowerCase();
  const matchingRestaurants = normalizedQuery
    ? restaurants
        .filter(
          (r) =>
            r.name.toLowerCase().includes(normalizedQuery) ||
            r.cuisines.some((c) => c.toLowerCase().includes(normalizedQuery)) ||
            r.locality.toLowerCase().includes(normalizedQuery)
        )
        .slice(0, 4)
    : [];

  const matchingDishes: { restaurant: RestaurantEntity; dish: DishItem }[] = [];
  if (normalizedQuery) {
    for (const res of restaurants) {
      for (const menu of res.menus) {
        for (const sub of menu.categories) {
          for (const item of sub.items) {
            if (
              item.name.toLowerCase().includes(normalizedQuery) ||
              item.desc.toLowerCase().includes(normalizedQuery)
            ) {
              matchingDishes.push({ restaurant: res, dish: item });
            }
          }
        }
      }
    }
  }

  return (
    <header
      className={`sticky top-0 z-40 border-b backdrop-blur-xl transition-colors ${
        isDark
          ? "bg-[#0A0D12]/90 border-white/10 text-white"
          : "bg-white/95 border-slate-200 text-slate-900"
      }`}
    >
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 min-h-20 py-3 flex flex-wrap items-center justify-between gap-3">
        {/* Brand Identity */}
        <div className="flex items-center gap-3 shrink-0">
          <div
            className="w-11 h-11 rounded-2xl flex items-center justify-center font-black text-xl text-white shadow-lg"
            style={{ backgroundColor: primaryFill(theme.primaryHex) }}
          >
            {theme.brandName.slice(0, 1)}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-black text-xl tracking-tight">
                {theme.brandName}
              </span>
              <span
                className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded-full border"
                style={{
                  borderColor: `${theme.primaryHex}55`,
                  color: "var(--brand-ink)",
                  backgroundColor: `${theme.primaryHex}15`,
                }}
              >
                Gourmet
              </span>
            </div>
            <p className="text-xs opacity-60 hidden sm:block truncate max-w-[230px]">
              {theme.tagline}
            </p>
          </div>
        </div>

        {/* Universal Search Container */}
        <div className="basis-full xl:basis-auto xl:flex-1 xl:max-w-2xl order-last xl:order-none relative min-w-0">
          <div
            className={`flex items-center rounded-2xl border px-3 py-2 transition-all shadow-sm ${
              isDark
                ? "bg-[#121721] border-white/10 focus-within:border-white/30"
                : "bg-slate-100 border-slate-200 focus-within:border-slate-400"
            }`}
          >
            {/* Universal Search Input */}
            <div className="flex items-center gap-2 flex-1">
              <Search className="w-4 h-4 opacity-50 shrink-0" />
              <input
                type="search"
                aria-label="Search restaurants"
                value={searchQuery}
                onFocus={() => setSearchFocused(true)}
                onBlur={() => setTimeout(() => setSearchFocused(false), 180)}
                onChange={(e) => onSearchChange(e.target.value)}
                placeholder="Search restaurants by name or place"
                data-testid="universal-search-input"
                className="w-full bg-transparent text-sm outline-none placeholder:opacity-50"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => onSearchChange("")}
                  aria-label="Clear search"
                  className="p-1 rounded-lg hover:bg-white/10"
                >
                  <X className="w-3.5 h-3.5 opacity-70" />
                </button>
              )}
            </div>
          </div>

          {/* Universal Search Autosuggest Dropdown (layoutEntries-uniSearchDesContainer).
              With no catalog to suggest from, the query filters the restaurant list on the page. */}
          {searchFocused && normalizedQuery.length > 0 && restaurants.length > 0 && (
            <div
              className={`absolute left-0 right-0 mt-2 rounded-2xl border p-4 shadow-2xl z-50 max-h-[420px] overflow-y-auto ${
                isDark
                  ? "bg-[#141A26] border-white/15 text-white"
                  : "bg-white border-slate-200 text-slate-900"
              }`}
            >
              {matchingRestaurants.length === 0 && matchingDishes.length === 0 ? (
                <div className="text-center py-6 text-sm opacity-60">
                  No matching restaurants or dishes for &ldquo;{searchQuery}&rdquo;
                </div>
              ) : (
                <div className="space-y-4">
                  {matchingRestaurants.length > 0 && (
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-wider opacity-50 mb-2">
                        Matching Restaurants
                      </div>
                      <div className="space-y-1.5">
                        {matchingRestaurants.map((res) => (
                          <button
                            key={res.resId}
                            type="button"
                            onMouseDown={() => onSelectRestaurant(res, "menu")}
                            className={`w-full flex items-center justify-between p-2 rounded-xl text-left transition ${
                              isDark ? "hover:bg-white/5" : "hover:bg-slate-100"
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <img
                                src={res.heroImage}
                                alt={res.name}
                                className="w-10 h-10 rounded-lg object-cover"
                              />
                              <div>
                                <div className="text-sm font-bold">{res.name}</div>
                                <div className="text-xs opacity-60">
                                  {res.locality} • {res.deliveryTimeText}
                                </div>
                              </div>
                            </div>
                            <span
                              className="text-xs font-bold px-2 py-1 rounded-lg text-white"
                              style={{ backgroundColor: primaryFill(theme.primaryHex) }}
                            >
                              ★ {res.ratings.DELIVERY.rating}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {matchingDishes.length > 0 && (
                    <div>
                      <div className="text-[11px] font-bold uppercase tracking-wider opacity-50 mb-2">
                        Matching Signature Dishes
                      </div>
                      <div className="space-y-1.5">
                        {matchingDishes.slice(0, 4).map(({ restaurant, dish }) => (
                          <div
                            key={`${restaurant.resId}_${dish.id}`}
                            className={`flex items-center justify-between p-2 rounded-xl ${
                              isDark ? "bg-white/[0.03]" : "bg-slate-50"
                            }`}
                          >
                            <div className="flex items-center gap-3">
                              <Utensils className="w-4 h-4 opacity-60" />
                              <div>
                                <div className="text-xs font-bold">{dish.name}</div>
                                <div className="text-[11px] opacity-60">
                                  {restaurant.name} • ₹{dish.price}
                                </div>
                              </div>
                            </div>
                            <button
                              type="button"
                              onMouseDown={() => onQuickAddDish(restaurant, dish)}
                              className="text-xs font-bold px-2.5 py-1 rounded-lg text-white"
                              style={{ backgroundColor: primaryFill(theme.primaryHex) }}
                            >
                              + Add
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center gap-2 max-w-full">
          {/* Active Order Tracker Pill */}
          {hasActiveOrder && (
            <button
              ref={activeOrderPillRef}
              type="button"
              onClick={onOpenActiveOrder}
              data-testid="live-crystal-order-pill"
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold text-white shadow-lg"
              style={{ backgroundColor: primaryFill(theme.primaryHex) }}
            >
              <Bike className="w-4 h-4" />
              <span className="hidden md:inline">Track Order</span>
            </button>
          )}

          {/* Brand & Theme Studio */}
          <button
            type="button"
            onClick={onOpenBrandStudio}
            data-testid="open-brand-studio"
            title="Customize Branding & Theme"
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border transition ${
              isDark
                ? "bg-white/5 border-white/10 hover:bg-white/10"
                : "bg-slate-100 border-slate-200 hover:bg-slate-200"
            }`}
          >
            <Palette className="w-4 h-4" style={{ color: "var(--brand-ink)" }} />
            <span className="hidden xl:inline">Brand Studio</span>
          </button>

          {/* Local Notification Inbox */}
          <button
            type="button"
            onClick={onOpenInbox}
            data-testid="navbar-inbox"
            aria-label={
              unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"
            }
            className={`relative p-2 rounded-xl border transition ${
              isDark
                ? "bg-white/5 border-white/10 hover:bg-white/10"
                : "bg-slate-100 border-slate-200 hover:bg-slate-200"
            }`}
          >
            <Bell className="w-4 h-4" />
            {unreadCount > 0 && (
              <span
                data-testid="inbox-unread-badge"
                className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-rose-500 text-white text-[9px] font-black flex items-center justify-center"
              >
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </button>

          {/* Offline Restaurant Table Billing POS */}
          <Link
            href="/pos"
            data-testid="navbar-pos-link"
            title="Open Offline Restaurant Table POS & Bill Calculator"
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border transition ${
              isDark
                ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-300 hover:bg-emerald-500/25"
                : "bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100"
            }`}
          >
            <Receipt className="w-4 h-4" />
            <span>Table POS</span>
          </Link>

          <Link
            href="/owner"
            data-testid="navbar-owner-link"
            title="Manage your restaurant and menu"
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border transition ${
              isDark
                ? "bg-white/5 border-white/10 hover:bg-white/10"
                : "bg-slate-100 border-slate-200 hover:bg-slate-200"
            }`}
          >
            <Utensils className="w-4 h-4" />
            <span>Owner menu</span>
          </Link>

          {/* Dark / Light Surface Toggle */}
          <button
            type="button"
            data-testid="navbar-account"
            onClick={onOpenAccount}
            title={accountName ? `Signed in as ${accountName}` : "Sign in or create an account"}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border transition ${
              accountName
                ? "bg-emerald-500/15 border-emerald-400/40 text-emerald-300 hover:bg-emerald-500/25"
                : isDark
                ? "bg-white/5 border-white/10 hover:bg-white/10"
                : "bg-slate-100 border-slate-200 hover:bg-slate-200"
            }`}
          >
            <UserRound className="w-4 h-4" />
            <span className="hidden lg:inline">{accountName ?? "Sign in"}</span>
          </button>

          <button
            type="button"
            onClick={onToggleDark}
            aria-label="Toggle color mode"
            className={`p-2 rounded-xl border transition ${
              isDark
                ? "bg-white/5 border-white/10 hover:bg-white/10"
                : "bg-slate-100 border-slate-200 hover:bg-slate-200"
            }`}
          >
            {isDark ? <Sun className="w-4 h-4 text-amber-400" /> : <Moon className="w-4 h-4" />}
          </button>

        </div>
      </div>
    </header>
  );
}
