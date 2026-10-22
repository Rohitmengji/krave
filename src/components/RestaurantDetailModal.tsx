"use client";

import React, { useEffect, useState } from "react";
import {
  X,
  Star,
  Clock,
  MapPin,
  ShieldCheck,
  Sparkles,
  Search,
  CheckCircle2,
  Calendar,
  Users,
  Receipt,
  ThumbsUp,
  MessageSquarePlus,
  Flame,
  Plus,
} from "lucide-react";
import {
  BrandThemePreset,
  DietaryType,
  DiningReservation,
  DishItem,
  ModifierOption,
  RestaurantEntity,
  RestaurantReview,
} from "@/types/krave";
import { calculateDiningPayBill } from "@/lib/cartEngine";
import { ALLERGENS, allergenLabels, dishAllergenStatus, portionSummary } from "@/lib/checkout";

interface RestaurantDetailModalProps {
  restaurant: RestaurantEntity;
  initialTab?: "menu" | "book" | "reviews";
  theme: BrandThemePreset;
  isDark: boolean;
  isGoldMember: boolean;
  onClose: () => void;
  onAddToCart: (
    restaurant: RestaurantEntity,
    dish: DishItem,
    quantity: number,
    selectedOptions: ModifierOption[],
    cookingInstruction?: string
  ) => void;
  onCreateReservation: (reservation: DiningReservation) => void;
  reservations: DiningReservation[];
  unavailableItemIds: string[];
  onToggleAvailability: (itemId: string, dishName: string) => void;
}

export function RestaurantDetailModal({
  restaurant,
  initialTab = "menu",
  theme,
  isDark,
  isGoldMember,
  onClose,
  onAddToCart,
  onCreateReservation,
  reservations,
  unavailableItemIds,
  onToggleAvailability,
}: RestaurantDetailModalProps) {
  const [activeTab, setActiveTab] = useState<"menu" | "book" | "reviews">(initialTab);
  const [menuSearch, setMenuSearch] = useState("");
  const [dietaryFilter, setDietaryFilter] = useState<"ALL" | DietaryType>("ALL");
  const [bestsellerOnly, setBestsellerOnly] = useState(false);
  const [avoiding, setAvoiding] = useState<string[]>([]);

  // Dish Customization Modal State
  const [customizingDish, setCustomizingDish] = useState<DishItem | null>(null);
  const [selectedOptions, setSelectedOptions] = useState<ModifierOption[]>([]);
  const [dishQty, setDishQty] = useState(1);
  const [cookingNote, setCookingNote] = useState("");

  // Dining Table Reservation State
  const [bookingDate, setBookingDate] = useState("Today, Oct 22");
  const [bookingGuests, setBookingGuests] = useState(2);
  const [selectedSlot, setSelectedSlot] = useState(
    restaurant.diningSlots[0]?.time || "08:00 PM"
  );
  const [guestName, setGuestName] = useState("Rohit Mengji");
  const [guestPhone, setGuestPhone] = useState("+91 98765 43210");
  const [specialRequest, setSpecialRequest] = useState(
    "Courtyard window table if available"
  );
  const [latestBooking, setLatestBooking] = useState<DiningReservation | null>(null);

  // DiningPay Calculator State
  const [diningBillInput, setDiningBillInput] = useState(2500);
  const [diningBillPaid, setDiningBillPaid] = useState(false);

  // Reviews State
  const [localReviews, setLocalReviews] = useState<RestaurantReview[]>(
    restaurant.reviews
  );
  const [newReviewText, setNewReviewText] = useState("");
  const [newReviewRating, setNewReviewRating] = useState(5);
  const [bookingError, setBookingError] = useState<string | null>(null);
  const [bookingSubmitting, setBookingSubmitting] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // Dismiss nested dish customizer first on Escape; otherwise close the restaurant modal.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (customizingDish) {
        setCustomizingDish(null);
      } else {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [customizingDish, onClose]);

  const openDishCustomizer = (dish: DishItem) => {
    setCustomizingDish(dish);
    setDishQty(1);
    setCookingNote("");
    const defaults: ModifierOption[] = [];
    for (const groupId of dish.modifier_group_ids) {
      const group = restaurant.modifierGroups[groupId];
      if (group) {
        const defOpt = group.options.find((o) => o.isDefault) || (group.required ? group.options[0] : undefined);
        if (defOpt) defaults.push(defOpt);
      }
    }
    setSelectedOptions(defaults);
  };

  const toggleModifierOption = (groupId: string, option: ModifierOption) => {
    const group = restaurant.modifierGroups[groupId];
    if (!group) return;

    if (group.maxSelect === 1) {
      const otherIds = new Set(group.options.map((o) => o.id));
      const withoutGroup = selectedOptions.filter((o) => !otherIds.has(o.id));
      setSelectedOptions([...withoutGroup, option]);
    } else {
      const exists = selectedOptions.some((o) => o.id === option.id);
      if (exists) {
        setSelectedOptions(selectedOptions.filter((o) => o.id !== option.id));
      } else {
        const countInGroup = selectedOptions.filter((o) =>
          group.options.some((go) => go.id === o.id)
        ).length;
        if (countInGroup < group.maxSelect) {
          setSelectedOptions([...selectedOptions, option]);
        }
      }
    }
  };

  const confirmDishCustomization = () => {
    if (!customizingDish) return;
    onAddToCart(
      restaurant,
      customizingDish,
      dishQty,
      selectedOptions,
      cookingNote.trim() || undefined
    );
    setCustomizingDish(null);
  };

  const handleConfirmBooking = async (e: React.FormEvent) => {
    e.preventDefault();
    if (bookingSubmitting) return;
    setBookingError(null);
    setBookingSubmitting(true);
    try {
      const response = await fetch("/api/webroutes/user/booking", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resId: restaurant.resId,
          date: bookingDate,
          timeSlot: selectedSlot,
          guests: bookingGuests,
          guestName,
          guestPhone,
          specialRequest,
          isGoldMember,
          membershipName: theme.membershipName,
        }),
      });
      const result = await response.json();
      if (!response.ok || !result?.reservation) {
        throw new Error(
          typeof result?.message === "string"
            ? result.message
            : "Could not complete table reservation."
        );
      }
      setLatestBooking(result.reservation);
      onCreateReservation(result.reservation);
    } catch (error) {
      setBookingError(
        error instanceof Error
          ? error.message
          : "Unable to confirm reservation. Please check your details."
      );
    } finally {
      setBookingSubmitting(false);
    }
  };

  const handlePostReview = async (e: React.FormEvent) => {
    e.preventDefault();
    setReviewError(null);
    try {
      const response = await fetch("/api/webroutes/reviews/post", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          resId: restaurant.resId,
          rating: newReviewRating,
          comment: newReviewText,
          userName: guestName,
          reviewType: "DINING",
        }),
      });
      const result = await response.json();
      if (!response.ok || !result?.review) {
        throw new Error(
          typeof result?.message === "string"
            ? result.message
            : "Please enter a review of at least 5 characters."
        );
      }
      setLocalReviews([result.review, ...localReviews]);
      setNewReviewText("");
    } catch (error) {
      setReviewError(
        error instanceof Error ? error.message : "Could not submit review."
      );
    }
  };

  const diningPayBreakdown = calculateDiningPayBill(
    diningBillInput,
    restaurant,
    isGoldMember
  );

  const renderDietaryIcon = (type: DietaryType) => {
    const color =
      type === "veg"
        ? "border-emerald-500 text-emerald-500"
        : type === "egg"
        ? "border-amber-500 text-amber-500"
        : "border-rose-500 text-rose-500";
    const dot =
      type === "veg"
        ? "bg-emerald-500"
        : type === "egg"
        ? "bg-amber-500"
        : "bg-rose-500";
    return (
      <span
        className={`w-4 h-4 rounded-sm border-2 flex items-center justify-center shrink-0 ${color}`}
        title={type.toUpperCase()}
      >
        <span className={`w-2 h-2 rounded-full ${dot}`} />
      </span>
    );
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={restaurant.name}
      data-testid="restaurant-detail-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-md p-2 sm:p-6 overflow-y-auto"
    >
      <div
        className={`relative w-full max-w-5xl rounded-3xl border shadow-2xl overflow-hidden my-auto max-h-[92vh] flex flex-col ${
          isDark
            ? "bg-[#0E131D] border-white/15 text-white"
            : "bg-white border-slate-200 text-slate-900"
        }`}
      >
        {/* Hero Header */}
        <div className="relative h-60 sm:h-72 shrink-0">
          <img
            src={restaurant.heroImage}
            alt={restaurant.name}
            className="w-full h-full object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-[#0E131D] via-black/50 to-black/25" />

          <button
            type="button"
            aria-label="Close restaurant details"
            onClick={onClose}
            data-testid="close-restaurant-modal"
            className="absolute top-4 right-4 p-2.5 rounded-full bg-black/60 text-white hover:bg-black/85 border border-white/20 transition"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="absolute bottom-4 left-6 right-6 flex flex-col sm:flex-row sm:items-end justify-between gap-4 text-white">
            <div>
              <div className="flex flex-wrap items-center gap-2 mb-2">
                <span
                  className="px-2.5 py-0.5 rounded-full text-[11px] font-bold text-white"
                  style={{ backgroundColor: theme.primaryHex }}
                >
                  {restaurant.walkinOffer.title}
                </span>
                <span className="px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-500/20 border border-emerald-400/40 text-emerald-300 flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5" />
                  FSSAI #{restaurant.fssaiLicense} • Hygiene {restaurant.hygieneRating}
                </span>
              </div>
              <h2 className="text-2xl sm:text-3xl font-black tracking-tight">
                {restaurant.name}
              </h2>
              <p className="text-xs sm:text-sm text-white/80 mt-0.5">
                {restaurant.cuisines.join(" • ")}
              </p>
              <p className="text-xs text-white/65 flex items-center gap-1.5 mt-1">
                <MapPin className="w-3.5 h-3.5 text-emerald-400" />
                {restaurant.address} ({restaurant.distanceText}) • {restaurant.openingHours}
              </p>
              <a
                href={`/restaurant/${restaurant.resId}`}
                data-testid="restaurant-permalink"
                className="text-[11px] font-bold text-emerald-400 hover:underline mt-1 inline-block"
              >
                Open shareable page →
              </a>
            </div>

            {/* Dual Rating Boxes */}
            <div className="flex items-center gap-2 shrink-0">
              <div className="px-3 py-2 rounded-2xl bg-black/65 backdrop-blur-md border border-white/15 text-center">
                <div className="flex items-center justify-center gap-1 text-emerald-400 font-black text-sm">
                  <Star className="w-4 h-4 fill-current" />
                  <span>{restaurant.ratings.DINING.rating}</span>
                </div>
                <div className="text-[10px] text-white/70">
                  {restaurant.ratings.DINING.reviewCount} Dining
                </div>
              </div>
              <div className="px-3 py-2 rounded-2xl bg-black/65 backdrop-blur-md border border-white/15 text-center">
                <div className="flex items-center justify-center gap-1 text-amber-400 font-black text-sm">
                  <Star className="w-4 h-4 fill-current" />
                  <span>{restaurant.ratings.DELIVERY.rating}</span>
                </div>
                <div className="text-[10px] text-white/70">
                  {restaurant.ratings.DELIVERY.reviewCount} Delivery
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <div
          className={`px-6 border-b flex items-center justify-between gap-4 shrink-0 ${
            isDark ? "border-white/10 bg-[#121721]" : "border-slate-200 bg-slate-50"
          }`}
        >
          <div className="flex items-center gap-2 overflow-x-auto py-2.5">
            {(
              [
                { id: "menu", label: "Order Online (Menu)" },
                { id: "book", label: "Book Table & DiningPay" },
                { id: "reviews", label: `Reviews (${localReviews.length})` },
              ] as const
            ).map((tab) => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => setActiveTab(tab.id)}
                  data-testid={`restaurant-tab-${tab.id}`}
                  className={`px-4 py-2 rounded-xl text-xs font-extrabold transition shrink-0 ${
                    active
                      ? "text-white shadow"
                      : "opacity-65 hover:opacity-100"
                  }`}
                  style={active ? { backgroundColor: theme.primaryHex } : undefined}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="hidden md:flex items-center gap-2 text-xs opacity-75">
            <Clock className="w-3.5 h-3.5" style={{ color: theme.primaryHex }} />
            <span>Express Delivery in {restaurant.deliveryTimeText}</span>
          </div>
        </div>

        {/* Scrollable Content Body */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {/* TAB 1: ORDER ONLINE MENU */}
          {activeTab === "menu" && (
            <div className="space-y-6">
              {/* Menu Filter Bar */}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="w-4 h-4 absolute left-3.5 top-1/2 -translate-y-1/2 opacity-50" />
                  <input
                    type="text"
                    value={menuSearch}
                    onChange={(e) => setMenuSearch(e.target.value)}
                    placeholder="Search within menu..."
                    className={`w-full pl-10 pr-4 py-2 rounded-xl border text-xs outline-none ${
                      isDark
                        ? "bg-white/5 border-white/10"
                        : "bg-slate-100 border-slate-200"
                    }`}
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  {(["ALL", "veg", "non-veg", "egg"] as const).map((dt) => (
                    <button
                      key={dt}
                      type="button"
                      onClick={() => setDietaryFilter(dt)}
                      className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition ${
                        dietaryFilter === dt
                          ? "border-emerald-500 bg-emerald-500/20 text-emerald-400"
                          : isDark
                          ? "border-white/10 bg-white/5"
                          : "border-slate-200 bg-slate-100"
                      }`}
                    >
                      {dt === "ALL" ? "All Items" : dt.toUpperCase()}
                    </button>
                  ))}

                  <button
                    type="button"
                    onClick={() => setBestsellerOnly((prev) => !prev)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition flex items-center gap-1 ${
                      bestsellerOnly
                        ? "border-amber-400 bg-amber-500/20 text-amber-300"
                        : isDark
                        ? "border-white/10 bg-white/5"
                        : "border-slate-200 bg-slate-100"
                    }`}
                  >
                    <Flame className="w-3.5 h-3.5 text-amber-400" />
                    Bestsellers
                  </button>
                </div>
              </div>

              {/* Allergen avoidance */}
              <div
                className={`p-3.5 rounded-2xl border space-y-2 ${
                  isDark ? "bg-[#141A26] border-white/10" : "bg-slate-50 border-slate-200"
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-bold">Avoid an allergen</span>
                  {avoiding.length > 0 && (
                    <button
                      type="button"
                      data-testid="allergen-clear"
                      onClick={() => setAvoiding([])}
                      className="text-[11px] font-bold opacity-70 hover:opacity-100 underline"
                    >
                      Clear
                    </button>
                  )}
                </div>

                <div className="flex flex-wrap gap-1.5">
                  {ALLERGENS.map((allergen) => {
                    const active = avoiding.includes(allergen.id);
                    return (
                      <button
                        key={allergen.id}
                        type="button"
                        aria-pressed={active}
                        data-testid={`allergen-${allergen.id}`}
                        onClick={() =>
                          setAvoiding((prev) =>
                            prev.includes(allergen.id)
                              ? prev.filter((id) => id !== allergen.id)
                              : [...prev, allergen.id]
                          )
                        }
                        className={`px-2.5 py-1 rounded-lg text-[11px] font-bold border transition ${
                          active
                            ? "border-rose-400 bg-rose-500/20 text-rose-300"
                            : isDark
                            ? "border-white/10 bg-white/5"
                            : "border-slate-200 bg-slate-100"
                        }`}
                      >
                        {allergen.label}
                      </button>
                    );
                  })}
                </div>

                {avoiding.length > 0 && (
                  <p data-testid="allergen-caveat" className="text-[11px] text-amber-300">
                    Dishes this kitchen has not declared are shown separately, not as safe.
                    Declarations come from the restaurant — always tell them directly about a
                    severe allergy.
                  </p>
                )}
              </div>

              {/* Menu Categories & Dishes */}
              {restaurant.menus.map((menu) => (
                <div key={menu.id} className="space-y-4">
                  <div className="border-b border-current/10 pb-2">
                    <h3 className="text-lg font-black">{menu.name}</h3>
                  </div>

                  {menu.categories.map((sub) => {
                    const filteredItems = sub.items.filter((item) => {
                      if (dietaryFilter !== "ALL" && item.dietary !== dietaryFilter)
                        return false;
                      if (bestsellerOnly && !item.bestseller) return false;
                      if (
                        menuSearch.trim() &&
                        !item.name
                          .toLowerCase()
                          .includes(menuSearch.trim().toLowerCase()) &&
                        !item.desc
                          .toLowerCase()
                          .includes(menuSearch.trim().toLowerCase())
                      ) {
                        return false;
                      }
                      return true;
                    });

                    if (filteredItems.length === 0) return null;

                    return (
                      <div key={sub.id} className="space-y-3">
                        <h4 className="text-xs font-bold uppercase tracking-wider opacity-60">
                          {sub.name} ({filteredItems.length})
                        </h4>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          {filteredItems.map((dish) => {
                            const isUnavailable = unavailableItemIds.includes(dish.id);
                            return (
                            <div
                              key={dish.id}
                              data-testid={`dish-card-${dish.id}`}
                              className={`p-4 rounded-2xl border flex justify-between gap-4 transition ${
                                isDark
                                  ? "bg-[#141A26] border-white/10 hover:border-white/25"
                                  : "bg-slate-50 border-slate-200 hover:border-slate-300"
                              } ${isUnavailable ? "opacity-60" : ""}`}
                            >
                              <div className="space-y-1.5 flex-1">
                                <div className="flex items-center gap-2">
                                  {renderDietaryIcon(dish.dietary)}
                                  {isUnavailable && (
                                    <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded bg-rose-500/20 text-rose-400">
                                      86 — Unavailable
                                    </span>
                                  )}
                                  {dish.bestseller && (
                                    <span className="text-[10px] font-extrabold uppercase px-2 py-0.5 rounded bg-amber-500/20 text-amber-400">
                                      ★ Bestseller
                                    </span>
                                  )}
                                  {dish.spiceLevel && (
                                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-rose-500/15 text-rose-400">
                                      {dish.spiceLevel}
                                    </span>
                                  )}
                                </div>

                                <div className="font-extrabold text-sm">
                                  {dish.name}
                                </div>

                                {(() => {
                                  const portion = portionSummary(dish.price, dish.portion);
                                  return (
                                    <div
                                      data-testid={`portion-${dish.id}`}
                                      className={`text-[11px] ${
                                        portion.declared ? "opacity-65" : "text-amber-300"
                                      }`}
                                    >
                                      {portion.label}
                                      {portion.pricePerHundredGrams !== null &&
                                        ` · ₹${portion.pricePerHundredGrams} per 100g`}
                                    </div>
                                  );
                                })()}

                                {(() => {
                                  const status = dishAllergenStatus(dish.allergens, avoiding);
                                  if (status === "CONTAINS") {
                                    return (
                                      <div
                                        data-testid={`allergen-contains-${dish.id}`}
                                        className="text-[11px] font-black text-rose-400"
                                      >
                                        Contains{" "}
                                        {allergenLabels(
                                          (dish.allergens ?? []).filter((id) =>
                                            avoiding.includes(id)
                                          )
                                        )}
                                      </div>
                                    );
                                  }
                                  if (status === "UNDECLARED") {
                                    return (
                                      <div
                                        data-testid={`allergen-undeclared-${dish.id}`}
                                        className="text-[11px] font-bold text-amber-300"
                                      >
                                        Allergens not declared — ask the restaurant
                                      </div>
                                    );
                                  }
                                  return (
                                    <div
                                      data-testid={`allergen-declared-${dish.id}`}
                                      className="text-[11px] opacity-65"
                                    >
                                      Declared:{" "}
                                      {(dish.allergens ?? []).length === 0
                                        ? "none of the listed allergens"
                                        : allergenLabels(dish.allergens ?? [])}
                                    </div>
                                  );
                                })()}

                                <div className="font-black text-sm" style={{ color: theme.primaryHex }}>
                                  ₹{dish.price}
                                </div>

                                {dish.rating && (
                                  <div className="text-[11px] font-bold text-amber-400">
                                    ★ {dish.rating.value}{" "}
                                    <span className="opacity-60 font-normal">
                                      ({dish.rating.votes} votes)
                                    </span>
                                  </div>
                                )}

                                <p className="text-xs opacity-65 line-clamp-2 leading-relaxed">
                                  {dish.desc}
                                </p>
                              </div>

                              {/* Dish Image + ADD Button */}
                              <div className="flex flex-col items-center justify-between shrink-0 w-28">
                                <img
                                  src={dish.item_image_url}
                                  alt={dish.name}
                                  className="w-28 h-24 rounded-xl object-cover border border-white/10"
                                />
                                <button
                                  type="button"
                                  onClick={() => openDishCustomizer(dish)}
                                  data-testid={`add-dish-${dish.id}`}
                                  disabled={isUnavailable}
                                  className="mt-2 w-full py-1.5 px-3 rounded-xl text-xs font-black text-white shadow flex items-center justify-center gap-1 transition hover:opacity-95 disabled:opacity-40"
                                  style={{ backgroundColor: theme.primaryHex }}
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                  <span>{isUnavailable ? "OFF MENU" : "ADD"}</span>
                                </button>
                                <button
                                  type="button"
                                  data-testid={`toggle-availability-${dish.id}`}
                                  onClick={() => onToggleAvailability(dish.id, dish.name)}
                                  className="mt-1 text-[9px] font-bold opacity-50 hover:opacity-90 underline"
                                >
                                  {isUnavailable ? "Staff: restore" : "Staff: mark 86"}
                                </button>
                                {dish.modifier_group_ids.length > 0 && (
                                  <span className="text-[9px] opacity-50 mt-0.5">
                                    Customisable
                                  </span>
                                )}
                              </div>
                            </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {/* TAB 2: BOOK TABLE & DINING PAY */}
          {activeTab === "book" && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {/* Left Column: Table Reservation Form */}
              <div
                className={`p-5 rounded-2xl border space-y-4 ${
                  isDark ? "bg-[#141A26] border-white/10" : "bg-slate-50 border-slate-200"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-black text-lg flex items-center gap-2">
                      <Calendar className="w-5 h-5" style={{ color: theme.primaryHex }} />
                      Reserve a Table
                    </h3>
                    <p className="text-xs opacity-65">
                      Instant table confirmation with complimentary walk-in perks
                    </p>
                  </div>
                  <span
                    className="px-2.5 py-1 rounded-xl text-xs font-bold text-white"
                    style={{ backgroundColor: theme.primaryHex }}
                  >
                    {restaurant.walkinOffer.title}
                  </span>
                </div>

                <form onSubmit={handleConfirmBooking} className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-xs font-bold mb-1 opacity-75">
                        Select Date
                      </label>
                      <select
                        value={bookingDate}
                        onChange={(e) => setBookingDate(e.target.value)}
                        className={`w-full p-2.5 rounded-xl border text-xs font-semibold ${
                          isDark
                            ? "bg-[#0E131D] border-white/15"
                            : "bg-white border-slate-200"
                        }`}
                      >
                        <option value="Today, Oct 22">Today, Oct 22</option>
                        <option value="Tomorrow, Oct 23">Tomorrow, Oct 23</option>
                        <option value="Saturday, Oct 24">Saturday, Oct 24</option>
                        <option value="Sunday, Oct 25">Sunday, Oct 25</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-xs font-bold mb-1 opacity-75">
                        Number of Guests
                      </label>
                      <div className="flex items-center gap-2">
                        <Users className="w-4 h-4 opacity-60" />
                        <select
                          value={bookingGuests}
                          onChange={(e) => setBookingGuests(Number(e.target.value))}
                          className={`w-full p-2.5 rounded-xl border text-xs font-semibold ${
                            isDark
                              ? "bg-[#0E131D] border-white/15"
                              : "bg-white border-slate-200"
                          }`}
                        >
                          {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
                            <option key={n} value={n}>
                              {n} {n === 1 ? "Guest" : "Guests"}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {/* Time Slots */}
                  <div>
                    <label className="block text-xs font-bold mb-2 opacity-75">
                      Available Dining Slots (With Walk-In Benefits)
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      {restaurant.diningSlots.map((slot) => {
                        const active = selectedSlot === slot.time;
                        return (
                          <button
                            key={slot.time}
                            type="button"
                            onClick={() => setSelectedSlot(slot.time)}
                            className={`p-2.5 rounded-xl border text-left transition ${
                              active
                                ? "border-emerald-400 bg-emerald-500/15"
                                : isDark
                                ? "border-white/10 bg-white/5"
                                : "border-slate-200 bg-white"
                            }`}
                          >
                            <div className="text-xs font-black">{slot.time}</div>
                            <div
                              className="text-[10px] font-bold"
                              style={{ color: theme.primaryHex }}
                            >
                              {slot.discountText}
                            </div>
                            <div className="text-[10px] opacity-55">
                              {slot.seatsLeft} tables left
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <input
                      type="text"
                      value={guestName}
                      onChange={(e) => setGuestName(e.target.value)}
                      placeholder="Guest Full Name"
                      className={`p-2.5 rounded-xl border text-xs ${
                        isDark ? "bg-[#0E131D] border-white/15" : "bg-white border-slate-200"
                      }`}
                    />
                    <input
                      type="text"
                      value={guestPhone}
                      onChange={(e) => setGuestPhone(e.target.value)}
                      placeholder="Phone Number"
                      className={`p-2.5 rounded-xl border text-xs ${
                        isDark ? "bg-[#0E131D] border-white/15" : "bg-white border-slate-200"
                      }`}
                    />
                  </div>

                  <input
                    type="text"
                    value={specialRequest}
                    onChange={(e) => setSpecialRequest(e.target.value)}
                    placeholder="Special requests (e.g. Anniversary cake, Quiet corner)"
                    className={`w-full p-2.5 rounded-xl border text-xs ${
                      isDark ? "bg-[#0E131D] border-white/15" : "bg-white border-slate-200"
                    }`}
                  />

                  {bookingError && (
                    <p role="alert" className="text-xs text-rose-400 font-semibold">
                      {bookingError}
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={bookingSubmitting}
                    data-testid="confirm-table-booking-btn"
                    className="w-full py-3 rounded-xl text-xs font-black text-white shadow-lg transition hover:opacity-95 disabled:opacity-50"
                    style={{ backgroundColor: theme.primaryHex }}
                  >
                    {bookingSubmitting
                      ? "Confirming Reservation..."
                      : `Confirm Table Reservation (${bookingGuests} Guests • ${selectedSlot})`}
                  </button>
                </form>

                {latestBooking && (
                  <div
                    data-testid="booking-confirmation-card"
                    className="p-4 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 space-y-1.5"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-black text-emerald-400 flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4" />
                        Table Reserved • {latestBooking.bookingId}
                      </span>
                      <span className="text-[10px] font-mono opacity-75">
                        {latestBooking.date} @ {latestBooking.timeSlot}
                      </span>
                    </div>
                    <p className="text-xs">
                      Reserved for <strong>{latestBooking.guestName}</strong> (
                      {latestBooking.guests} guests) —{" "}
                      <span className="text-emerald-300 font-semibold">
                        {latestBooking.offerApplied}
                      </span>
                    </p>
                  </div>
                )}
              </div>

              {/* Right Column: DiningPay Instant Bill Calculator */}
              <div
                className={`p-5 rounded-2xl border space-y-4 ${
                  isDark ? "bg-[#141A26] border-white/10" : "bg-slate-50 border-slate-200"
                }`}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="font-black text-lg flex items-center gap-2">
                      <Receipt className="w-5 h-5 text-amber-400" />
                      {theme.brandName} DiningPay Calculator
                    </h3>
                    <p className="text-xs opacity-65">
                      Pay your restaurant table bill in-app and unlock instant walk-in savings
                    </p>
                  </div>
                  <Sparkles className="w-5 h-5 text-amber-400" />
                </div>

                <div>
                  <label className="block text-xs font-bold mb-1.5 opacity-75">
                    Enter Restaurant Table Bill Amount (₹)
                  </label>
                  <input
                    type="number"
                    min={100}
                    step={100}
                    value={diningBillInput}
                    onChange={(e) => {
                      setDiningBillInput(Number(e.target.value));
                      setDiningBillPaid(false);
                    }}
                    className={`w-full p-3 rounded-xl border text-base font-black ${
                      isDark ? "bg-[#0E131D] border-white/15" : "bg-white border-slate-200"
                    }`}
                  />
                </div>

                <div
                  className={`p-4 rounded-2xl border space-y-2 text-xs ${
                    isDark ? "bg-[#0E131D] border-white/10" : "bg-white border-slate-200"
                  }`}
                >
                  <div className="flex justify-between">
                    <span className="opacity-70">Total Table Bill</span>
                    <span className="font-bold">₹{diningPayBreakdown.billAmount}</span>
                  </div>
                  <div className="flex justify-between text-emerald-400">
                    <span>
                      Walk-in Discount ({restaurant.walkinOffer.basePercent}% OFF)
                    </span>
                    <span className="font-bold">-₹{diningPayBreakdown.baseDiscount}</span>
                  </div>
                  <div className="flex justify-between text-amber-400">
                    <span>
                      {theme.membershipName} Extra ({restaurant.walkinOffer.goldExtraPercent}% OFF)
                    </span>
                    <span className="font-bold">
                      {isGoldMember
                        ? `-₹${diningPayBreakdown.goldExtraDiscount}`
                        : "Enable Luxe to save more"}
                    </span>
                  </div>
                  <div className="flex justify-between opacity-60">
                    <span>Platform Convenience Fee</span>
                    <span>₹{diningPayBreakdown.convenienceFee}</span>
                  </div>
                  <div className="border-t border-current/10 pt-2 flex justify-between text-sm font-black">
                    <span>Final Amount Payable</span>
                    <span style={{ color: theme.primaryHex }}>
                      ₹{diningPayBreakdown.finalPayable}
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => setDiningBillPaid(true)}
                  className="w-full py-3 rounded-xl text-xs font-black text-white shadow-lg transition hover:opacity-95"
                  style={{ backgroundColor: theme.primaryHex }}
                >
                  Pay ₹{diningPayBreakdown.finalPayable} & Save ₹{diningPayBreakdown.totalSaved} Instantly
                </button>

                {diningBillPaid && (
                  <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-xs text-emerald-300 font-semibold flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0" />
                    DiningPay receipt generated! You saved ₹{diningPayBreakdown.totalSaved} on your table bill.
                  </div>
                )}

                {reservations.length > 0 && (
                  <div className="pt-2">
                    <div className="text-[11px] font-bold uppercase tracking-wider opacity-60 mb-2">
                      Your Active Table Reservations ({reservations.length})
                    </div>
                    <div className="space-y-1.5 max-h-28 overflow-y-auto">
                      {reservations.map((r) => (
                        <div
                          key={r.bookingId}
                          className="text-xs p-2 rounded-lg bg-white/5 border border-white/10 flex justify-between"
                        >
                          <span className="font-bold">{r.restaurantName}</span>
                          <span className="opacity-75">
                            {r.date} • {r.timeSlot} ({r.guests}p)
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 3: REVIEWS */}
          {activeTab === "reviews" && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <form
                onSubmit={handlePostReview}
                className={`p-5 rounded-2xl border space-y-3 h-fit ${
                  isDark ? "bg-[#141A26] border-white/10" : "bg-slate-50 border-slate-200"
                }`}
              >
                <h3 className="font-black text-sm flex items-center gap-2">
                  <MessageSquarePlus className="w-4 h-4" style={{ color: theme.primaryHex }} />
                  Write a Verified Review
                </h3>
                <div>
                  <label className="block text-xs opacity-70 mb-1">Rating</label>
                  <div className="flex gap-1.5">
                    {[1, 2, 3, 4, 5].map((star) => (
                      <button
                        key={star}
                        type="button"
                        onClick={() => setNewReviewRating(star)}
                        className={`px-2.5 py-1 rounded-lg text-xs font-bold border ${
                          newReviewRating >= star
                            ? "bg-amber-500/20 border-amber-400 text-amber-300"
                            : "border-white/10 opacity-50"
                        }`}
                      >
                        {star} ★
                      </button>
                    ))}
                  </div>
                </div>
                <textarea
                  rows={3}
                  value={newReviewText}
                  onChange={(e) => setNewReviewText(e.target.value)}
                  placeholder="Share your experience with the food, packaging, or courtyard ambience..."
                  className={`w-full p-3 rounded-xl border text-xs outline-none ${
                    isDark ? "bg-[#0E131D] border-white/15" : "bg-white border-slate-200"
                  }`}
                />
                {reviewError && (
                  <p role="alert" className="text-xs text-rose-400 font-semibold">
                    {reviewError}
                  </p>
                )}
                <button
                  type="submit"
                  className="w-full py-2.5 rounded-xl text-xs font-black text-white"
                  style={{ backgroundColor: theme.primaryHex }}
                >
                  Publish Review
                </button>
              </form>

              <div className="lg:col-span-2 space-y-3">
                {localReviews.map((rev) => (
                  <div
                    key={rev.id}
                    className={`p-4 rounded-2xl border space-y-2 ${
                      isDark ? "bg-[#141A26] border-white/10" : "bg-slate-50 border-slate-200"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2.5">
                        <div
                          className="w-9 h-9 rounded-full flex items-center justify-center font-bold text-xs text-white"
                          style={{ backgroundColor: theme.primaryHex }}
                        >
                          {rev.userAvatar}
                        </div>
                        <div>
                          <div className="text-xs font-bold">{rev.userName}</div>
                          <div className="text-[10px] opacity-60">
                            {rev.userHandle} • {rev.timestamp} • {rev.reviewType}
                          </div>
                        </div>
                        {rev.verifiedPurchase && (
                          <span
                            data-testid={`review-verified-${rev.id}`}
                            className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-bold"
                          >
                            ✓ Verified order
                          </span>
                        )}
                      </div>
                      <span
                        className="px-2.5 py-1 rounded-lg text-xs font-black text-white"
                        style={{ backgroundColor: theme.primaryHex }}
                      >
                        ★ {rev.rating}
                      </span>
                    </div>
                    <p className="text-xs leading-relaxed opacity-90">{rev.comment}</p>
                    <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                      <div className="flex flex-wrap gap-1.5">
                        {rev.positiveTags.map((tag) => (
                          <span
                            key={tag}
                            className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-semibold"
                          >
                            ✓ {tag}
                          </span>
                        ))}
                      </div>
                      <span className="text-[11px] opacity-60 flex items-center gap-1">
                        <ThumbsUp className="w-3 h-3" /> {rev.likes} Helpful
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Nested Dish Customization Modal */}
        {customizingDish && (
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Customise ${customizingDish.name}`}
            data-testid="dish-customization-modal"
            className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4"
          >
            <div
              className={`w-full max-w-lg rounded-3xl border p-6 shadow-2xl space-y-4 max-h-[85vh] overflow-y-auto ${
                isDark
                  ? "bg-[#141A26] border-white/15 text-white"
                  : "bg-white border-slate-200 text-slate-900"
              }`}
            >
              <div className="flex items-start justify-between gap-3 border-b border-current/10 pb-3">
                <div>
                  <span className="text-[10px] font-bold uppercase tracking-wider opacity-60">
                    Customise Your Dish
                  </span>
                  <h4 className="font-black text-lg">{customizingDish.name}</h4>
                  <p className="text-xs opacity-65">Base Price: ₹{customizingDish.price}</p>
                </div>
                <button
                  type="button"
                  aria-label="Close dish customisation"
                  onClick={() => setCustomizingDish(null)}
                  className="p-1.5 rounded-full hover:bg-white/10"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              {customizingDish.modifier_group_ids.length === 0 ? (
                <p className="text-xs opacity-70">
                  Prepared to chef&apos;s signature specification. Add any special cooking note below.
                </p>
              ) : (
                <div className="space-y-4">
                  {customizingDish.modifier_group_ids.map((groupId) => {
                    const group = restaurant.modifierGroups[groupId];
                    if (!group) return null;
                    return (
                      <div key={group.id} className="space-y-2">
                        <div>
                          <div className="text-xs font-extrabold">{group.title}</div>
                          <div className="text-[11px] opacity-60">{group.subtitle}</div>
                        </div>
                        <div className="space-y-1.5">
                          {group.options.map((opt) => {
                            const checked = selectedOptions.some((o) => o.id === opt.id);
                            return (
                              <button
                                key={opt.id}
                                type="button"
                                onClick={() => toggleModifierOption(group.id, opt)}
                                className={`w-full flex items-center justify-between p-2.5 rounded-xl border text-xs transition ${
                                  checked
                                    ? "border-emerald-500 bg-emerald-500/15 font-bold"
                                    : isDark
                                    ? "border-white/10 bg-white/5"
                                    : "border-slate-200 bg-slate-50"
                                }`}
                              >
                                <div className="flex items-center gap-2">
                                  {renderDietaryIcon(opt.dietary)}
                                  <span>{opt.name}</span>
                                </div>
                                <span>{opt.price > 0 ? `+₹${opt.price}` : "Included"}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              <div>
                <label className="block text-xs font-bold mb-1 opacity-75">
                  Cooking Instructions (Optional)
                </label>
                <input
                  type="text"
                  value={cookingNote}
                  onChange={(e) => setCookingNote(e.target.value)}
                  placeholder="e.g. Less spicy, pack chutneys separately"
                  className={`w-full p-2.5 rounded-xl border text-xs ${
                    isDark ? "bg-[#0E131D] border-white/15" : "bg-slate-50 border-slate-200"
                  }`}
                />
              </div>

              <div className="flex items-center justify-between gap-3 pt-2">
                <div className="flex items-center border border-current/20 rounded-xl overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setDishQty((q) => Math.max(1, q - 1))}
                    className="px-3 py-2 text-sm font-black hover:bg-white/10"
                  >
                    -
                  </button>
                  <span className="px-3 py-2 text-xs font-black">{dishQty}</span>
                  <button
                    type="button"
                    onClick={() => setDishQty((q) => q + 1)}
                    className="px-3 py-2 text-sm font-black hover:bg-white/10"
                  >
                    +
                  </button>
                </div>

                <button
                  type="button"
                  onClick={confirmDishCustomization}
                  data-testid="confirm-add-to-cart-btn"
                  className="flex-1 py-3 px-4 rounded-xl text-xs font-black text-white shadow-lg"
                  style={{ backgroundColor: theme.primaryHex }}
                >
                  Add Item to Cart • ₹
                  {(customizingDish.price +
                    selectedOptions.reduce((s, o) => s + o.price, 0)) *
                    dishQty}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
