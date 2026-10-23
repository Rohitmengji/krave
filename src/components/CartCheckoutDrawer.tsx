"use client";

import React, { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  allergenLabels,
  DELIVERY_SLOTS,
  DEMO_PAYMENT_METHODS,
  deliverySlotProblem,
  KITCHEN_FLAGS,
  type KitchenHandling,
} from "@/lib/checkout";
import { CART_LIMITS } from "@/lib/cartEngine";
import { useMinuteClock } from "@/lib/useMinuteClock";
import {
  X,
  ShoppingBag,
  Tag,
  Sparkles,
  Trash2,
  MapPin,
  Clock,
  CreditCard,
  ShieldCheck,
  ChefHat,
  ArrowRight,
  HeartHandshake,
} from "lucide-react";
import {
  BrandThemePreset,
  CartLineItem,
  CartQuote,
  CouponOffer,
  LocationAddress,
  ZPayKitEventRecord,
} from "@/types/krave";

interface CartCheckoutDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  theme: BrandThemePreset;
  isDark: boolean;
  items: CartLineItem[];
  quote: CartQuote;
  coupons: CouponOffer[];
  appliedCoupon: string | null;
  /** Why the applied coupon cannot be used by this customer right now, if it cannot. */
  couponBlockedReason: string | null;
  onApplyCoupon: (code: string | null) => void;
  riderTip: number;
  onSelectRiderTip: (tip: number) => void;
  isGoldMember: boolean;
  onToggleGold: () => void;
  currentAddress: LocationAddress;
  onUpdateQuantity: (lineItemId: string, quantity: number) => void;
  onClearCart: () => void;
  onPlaceOrder: (paymentMethod: string, zpayEvents: ZPayKitEventRecord[]) => Promise<void>;
  paymentMethod: string;
  onSelectPaymentMethod: (method: string) => void;
  checkoutPending: boolean;
  checkoutError: string | null;
  scheduledSlot: string;
  onSelectScheduledSlot: (slot: string) => void;
  unavailableItemIds: string[];
  handling: KitchenHandling;
  onChangeHandling: (handling: KitchenHandling) => void;
  priceLockExpiresAt: number | null;
}

export function CartCheckoutDrawer({
  isOpen,
  onClose,
  theme,
  isDark,
  items,
  quote,
  coupons,
  appliedCoupon,
  couponBlockedReason,
  onApplyCoupon,
  riderTip,
  onSelectRiderTip,
  isGoldMember,
  onToggleGold,
  currentAddress,
  onUpdateQuantity,
  onClearCart,
  onPlaceOrder,
  paymentMethod: selectedPayment,
  onSelectPaymentMethod,
  checkoutPending,
  checkoutError,
  scheduledSlot,
  onSelectScheduledSlot,
  unavailableItemIds,
  handling,
  onChangeHandling,
  priceLockExpiresAt,
}: CartCheckoutDrawerProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const handleEscape = useEffectEvent((event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (!checkoutPending) onClose();
  });
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!isOpen || !dialog) return;
    if (!dialog.open) dialog.showModal();
    document.addEventListener("keydown", handleEscape, true);
    return () => {
      document.removeEventListener("keydown", handleEscape, true);
      if (dialog.open) dialog.close();
    };
  }, [isOpen]);
  const [zpayEvents, setZpayEvents] = useState<ZPayKitEventRecord[]>([
    {
      id: "zp_init",
      timestamp: "init",
      direction: "WIDGET_TO_HOST",
      topic: "widget_status",
      payload: { status: true, sdk: "zpaykit/js/v4/hook.js" },
    },
  ]);

  const clockMinute = useMinuteClock();

  if (!isOpen) return null;

  const hasUnavailableItem = items.some((line) => unavailableItemIds.includes(line.item.id));
  const allergySelected = handling.flags.includes("ALLERGY");
  const allergyNoteMissing = allergySelected && handling.allergyNote.trim().length < 3;
  const slotProblem = (slot: string) =>
    clockMinute === null ? null : deliverySlotProblem(slot, new Date(clockMinute));
  // A window saved earlier (or left open in a tab) can pass; the server refuses it too.
  const scheduledSlotProblem = slotProblem(scheduledSlot);

  const toggleFlag = (id: KitchenHandling["flags"][number]) => {
    const flags = handling.flags.includes(id)
      ? handling.flags.filter((flag) => flag !== id)
      : [...handling.flags, id];
    onChangeHandling({
      flags,
      allergyNote: flags.includes("ALLERGY") ? handling.allergyNote : "",
    });
  };

  const pushZpayEvent = (
    direction: "HOST_TO_WIDGET" | "WIDGET_TO_HOST",
    topic: ZPayKitEventRecord["topic"],
    payload: Record<string, unknown>
  ) => {
    const next: ZPayKitEventRecord = {
      id: `zp_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }),
      direction,
      topic,
      payload,
    };
    setZpayEvents((prev) => [...prev, next]);
    return next;
  };

  const handleSelectPaymentMethod = (method: string) => {
    onSelectPaymentMethod(method);
    pushZpayEvent("HOST_TO_WIDGET", "change_billing_details", {
      paymentMethod: method,
      quoteId: quote.quoteId,
      grandTotal: quote.grandTotal,
    });
  };

  const handleTriggerZPayCheckout = () => {
    const clickEvt = pushZpayEvent("HOST_TO_WIDGET", "pay_button_clicked", {
      quoteId: quote.quoteId,
      amount: quote.grandTotal,
      method: selectedPayment,
    });
    onPlaceOrder(selectedPayment, [...zpayEvents, clickEvt]);
  };

  return (
    <dialog
      ref={dialogRef}
      data-testid="cart-checkout-drawer"
      aria-label="Checkout"
      onCancel={(event) => { event.preventDefault(); if (!checkoutPending) onClose(); }}
      className="fixed inset-0 z-50 m-0 p-0 border-0 w-screen h-dvh max-w-none max-h-none flex justify-end bg-black/70 backdrop-blur-sm"
    >
      <div
        className={`w-full max-w-xl h-full flex flex-col border-l shadow-2xl ${
          isDark
            ? "bg-[#0E131D] border-white/15 text-white"
            : "bg-white border-slate-200 text-slate-900"
        }`}
      >
        {/* Drawer Header */}
        <div className="p-5 border-b border-current/10 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className="w-9 h-9 rounded-xl flex items-center justify-center text-white"
              style={{ backgroundColor: theme.primaryHex }}
            >
              <ShoppingBag className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-black text-lg">
                {items.length > 0 ? items[0].restaurantName : "Your Cart"}
              </h2>
              <p className="text-xs opacity-65">
                {items.length > 0
                  ? `${quote.itemCount} ${quote.itemCount === 1 ? "item" : "items"} • Estimated delivery in 25–35 mins`
                  : "Add dishes from a kitchen to start your order"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {items.length > 0 && (
              <button
                type="button"
                onClick={onClearCart}
                disabled={checkoutPending}
                className="p-2 rounded-xl text-xs opacity-65 hover:opacity-100 hover:bg-rose-500/15 hover:text-rose-400 transition flex items-center gap-1"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>
            )}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close checkout"
              disabled={checkoutPending}
              data-testid="close-cart-drawer"
              className="p-2 rounded-xl hover:bg-white/10"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Drawer Body */}
        {items.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center space-y-3">
            <ShoppingBag className="w-12 h-12 opacity-30" />
            <h3 className="font-extrabold text-lg">Your gourmet cart is empty</h3>
            <p className="text-xs opacity-60 max-w-xs">
              Explore partner kitchens and add signature dishes to place your order.
            </p>
          </div>
        ) : (
          <fieldset disabled={checkoutPending} className="flex-1 overflow-y-auto p-5 space-y-5 min-h-0">
            {/* Delivery Address Card */}
            <div
              className={`p-3.5 rounded-2xl border flex items-start gap-3 ${
                isDark ? "bg-[#141A26] border-white/10" : "bg-slate-50 border-slate-200"
              }`}
            >
              <MapPin
                className="w-4 h-4 mt-0.5 shrink-0"
                style={{ color: theme.primaryHex }}
              />
              <div className="text-xs">
                <div className="font-bold">
                  Delivering to {currentAddress.alias}: {currentAddress.displayTitle}
                </div>
                <div className="opacity-65 mt-0.5">{currentAddress.displaySubtitle}</div>
              </div>
            </div>

            {/* Delivery Time */}
            <div
              className={`p-3.5 rounded-2xl border space-y-2 ${
                isDark ? "bg-[#141A26] border-white/10" : "bg-slate-50 border-slate-200"
              }`}
            >
              <div className="flex items-center gap-2 text-xs font-bold">
                <Clock className="w-4 h-4" style={{ color: theme.primaryHex }} />
                <span>Delivery Time</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {DELIVERY_SLOTS.map((slot) => (
                  <button
                    key={slot}
                    type="button"
                    aria-pressed={scheduledSlot === slot}
                    data-testid={`schedule-slot-${slot.replace(/\W+/g, "-").toLowerCase()}`}
                    onClick={() => onSelectScheduledSlot(slot)}
                    disabled={scheduledSlot !== slot && slotProblem(slot) !== null}
                    title={slotProblem(slot) ?? undefined}
                    className={`px-3 py-1.5 rounded-xl text-[11px] font-bold border transition disabled:opacity-40 disabled:cursor-not-allowed ${
                      scheduledSlot === slot
                        ? "text-white border-transparent"
                        : isDark
                        ? "border-white/15 hover:bg-white/5"
                        : "border-slate-200 hover:bg-slate-100"
                    }`}
                    style={
                      scheduledSlot === slot ? { backgroundColor: theme.primaryHex } : undefined
                    }
                  >
                    {slot}
                  </button>
                ))}
              </div>
              {scheduledSlotProblem ? (
                <p role="status" data-testid="schedule-slot-problem" className="text-[11px] text-amber-400 font-semibold">
                  {scheduledSlotProblem}
                </p>
              ) : scheduledSlot !== DELIVERY_SLOTS[0] && (
                <p className="text-[10px] opacity-65">
                  Scheduling is recorded on the demo order. Nothing is dispatched at that time.
                </p>
              )}
            </div>

            {/* Kitchen Handling */}
            <div
              className={`p-3.5 rounded-2xl border space-y-2 ${
                isDark ? "bg-[#141A26] border-white/10" : "bg-slate-50 border-slate-200"
              }`}
            >
              <div className="flex items-center gap-2 text-xs font-bold">
                <ChefHat className="w-4 h-4" style={{ color: theme.primaryHex }} />
                <span>Tell the Kitchen</span>
              </div>
              <div className="flex flex-wrap gap-2">
                {KITCHEN_FLAGS.map((flag) => {
                  const selected = handling.flags.includes(flag.id);
                  return (
                    <button
                      key={flag.id}
                      type="button"
                      aria-pressed={selected}
                      data-testid={`kitchen-flag-${flag.id}`}
                      onClick={() => toggleFlag(flag.id)}
                      className={`px-3 py-1.5 rounded-xl text-[11px] font-bold border transition ${
                        selected
                          ? "text-white border-transparent"
                          : isDark
                          ? "border-white/15 hover:bg-white/5"
                          : "border-slate-200 hover:bg-slate-100"
                      }`}
                      style={selected ? { backgroundColor: theme.primaryHex } : undefined}
                    >
                      {flag.label}
                    </button>
                  );
                })}
              </div>

              {allergySelected && (
                <label className="block space-y-1">
                  <span className="text-[11px] font-bold">
                    What is the allergy? The kitchen cannot act on “allergy” alone.
                  </span>
                  <input
                    type="text"
                    required
                    maxLength={200}
                    value={handling.allergyNote}
                    data-testid="allergy-note"
                    onChange={(event) =>
                      onChangeHandling({ ...handling, allergyNote: event.target.value })
                    }
                    placeholder="e.g. severe peanut allergy"
                    className={`w-full rounded-xl border px-3 py-2 text-xs ${
                      isDark ? "bg-[#0E131D] border-white/15" : "bg-white border-slate-200"
                    }`}
                  />
                </label>
              )}

              {handling.flags.length > 0 && (
                <p className="text-[10px] opacity-65">
                  Printed on the kitchen ticket at the restaurant, not just stored on the order.
                </p>
              )}
            </div>

            {/* Line Items */}
            <div
              className={`p-4 rounded-2xl border space-y-3 ${
                isDark ? "bg-[#141A26] border-white/10" : "bg-slate-50 border-slate-200"
              }`}
            >
              {items.map((li) => (
                <div
                  key={li.lineItemId}
                  className="flex items-start justify-between gap-3 pb-3 border-b border-current/10 last:border-b-0 last:pb-0"
                >
                  <div className="space-y-1">
                    <div className="text-xs font-extrabold">{li.item.name}</div>
                    {unavailableItemIds.includes(li.item.id) && (
                      <div className="text-[10px] font-black text-rose-400">
                        Unavailable — remove to continue
                      </div>
                    )}
                    {li.selectedOptions.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {li.selectedOptions.map((opt) => (
                          <span
                            key={opt.id}
                            className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 opacity-80"
                          >
                            {opt.name}
                          </span>
                        ))}
                      </div>
                    )}
                    {li.cookingInstruction && (
                      <div className="text-[10px] italic opacity-65">
                        Note: &ldquo;{li.cookingInstruction}&rdquo;
                      </div>
                    )}
                    {allergySelected && (
                      <div
                        data-testid={`cart-allergens-${li.lineItemId}`}
                        className={`text-[10px] font-bold ${
                          li.item.allergens ? "opacity-70" : "text-amber-300"
                        }`}
                      >
                        {li.item.allergens
                          ? `Declared: ${
                              li.item.allergens.length > 0
                                ? allergenLabels(li.item.allergens)
                                : "none of the listed allergens"
                            }`
                          : "This kitchen has not declared allergens for this dish"}
                      </div>
                    )}
                    <div className="text-xs font-bold opacity-80">
                      ₹{li.unitPrice} each
                    </div>
                  </div>

                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    <div className="flex items-center border border-current/20 rounded-xl overflow-hidden">
                      <button
                        type="button"
                        aria-label={`One fewer ${li.item.name}`}
                        onClick={() =>
                          onUpdateQuantity(li.lineItemId, li.quantity - 1)
                        }
                        className="px-2.5 py-1 text-xs font-black hover:bg-white/10"
                      >
                        -
                      </button>
                      <span className="px-2.5 py-1 text-xs font-black">
                        {li.quantity}
                      </span>
                      <button
                        type="button"
                        aria-label={`One more ${li.item.name}`}
                        disabled={li.quantity >= CART_LIMITS.maxLineQuantity}
                        onClick={() =>
                          onUpdateQuantity(li.lineItemId, li.quantity + 1)
                        }
                        className="px-2.5 py-1 text-xs font-black hover:bg-white/10 disabled:opacity-40"
                      >
                        +
                      </button>
                    </div>
                    <div className="text-xs font-black" style={{ color: theme.primaryHex }}>
                      ₹{li.unitPrice * li.quantity}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {/* Luxe Membership Upsell / Active Banner */}
            <button
              type="button"
              aria-pressed={isGoldMember}
              onClick={onToggleGold}
              className={`w-full text-left p-3.5 rounded-2xl border cursor-pointer transition flex items-center justify-between ${
                isGoldMember
                  ? "bg-amber-500/15 border-amber-400/50 text-amber-300"
                  : isDark
                  ? "bg-[#141A26] border-white/10 hover:border-amber-400/40"
                  : "bg-amber-50 border-amber-200"
              }`}
            >
              <span className="flex items-center gap-2.5">
                <Sparkles className="w-4 h-4 text-amber-400 shrink-0" />
                <span>
                  <span className="block text-xs font-black">
                    {theme.membershipName} — Free Delivery + 5% Extra Off
                  </span>
                  <span className="block text-[11px] opacity-75">
                    {isGoldMember
                      ? `Saving ₹${quote.goldDiscount + (quote.itemTotal >= 699 ? 25 : 49)} on this order`
                      : "Tap to activate instant member privileges"}
                  </span>
                </span>
              </span>
              <span className="text-[10px] font-black px-2 py-1 rounded bg-amber-500 text-black">
                {isGoldMember ? "ACTIVE" : "ENABLE"}
              </span>
            </button>

            {/* Coupons & Partner Offers */}
            <div className="space-y-2">
              <div className="text-xs font-bold flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5" style={{ color: theme.primaryHex }} />
                <span>Coupons & Partner Offers</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {coupons.map((cp) => {
                  const isApplied = quote.couponCode === cp.code;
                  const eligible = quote.itemTotal >= cp.minOrder;
                  return (
                    <button
                      key={cp.code}
                      type="button"
                      disabled={!eligible}
                      onClick={() =>
                        onApplyCoupon(isApplied ? null : cp.code)
                      }
                      data-testid={`coupon-btn-${cp.code}`}
                      className={`p-2.5 rounded-xl border text-left transition ${
                        isApplied
                          ? "border-emerald-400 bg-emerald-500/15"
                          : eligible
                          ? isDark
                            ? "border-white/10 bg-[#141A26] hover:border-white/25"
                            : "border-slate-200 bg-slate-50"
                          : "opacity-40 cursor-not-allowed border-white/5"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-black font-mono">
                          {cp.code}
                        </span>
                        <span className="text-[10px] font-bold text-emerald-400">
                          {isApplied ? "APPLIED ✓" : "APPLY"}
                        </span>
                      </div>
                      <div className="text-[11px] font-semibold mt-0.5">
                        {cp.title}
                      </div>
                      <div className="text-[10px] opacity-60">
                        Min ₹{cp.minOrder}
                      </div>
                    </button>
                  );
                })}
              </div>

              {appliedCoupon && quote.couponCode !== appliedCoupon && (
                <p className="text-[11px] text-amber-400" data-testid="coupon-not-applied">
                  {couponBlockedReason
                    ? `${couponBlockedReason} It will apply once that changes.`
                    : `${appliedCoupon} is not applied: this cart does not meet its conditions yet.`}
                </p>
              )}
            </div>

            {/* Rider Tip */}
            <div className="space-y-2">
              <div className="text-xs font-bold flex items-center gap-1.5">
                <HeartHandshake className="w-3.5 h-3.5 text-amber-400" />
                <span>Tip Your Delivery Partner (100% goes to valet)</span>
              </div>
              <div className="flex gap-2">
                {[0, 20, 30, 50].map((tip) => (
                  <button
                    key={tip}
                    type="button"
                    onClick={() => onSelectRiderTip(tip)}
                    className={`flex-1 py-1.5 rounded-xl border text-xs font-bold transition ${
                      riderTip === tip
                        ? "border-emerald-400 bg-emerald-500/20 text-emerald-300"
                        : isDark
                        ? "border-white/10 bg-[#141A26]"
                        : "border-slate-200 bg-slate-50"
                    }`}
                  >
                    {tip === 0 ? "No Tip" : `₹${tip}`}
                  </button>
                ))}
              </div>
            </div>

            {/* Itemized Bill Quote (zomato_quote_cart) */}
            <div
              className={`p-4 rounded-2xl border space-y-2 text-xs ${
                isDark ? "bg-[#141A26] border-white/10" : "bg-slate-50 border-slate-200"
              }`}
            >
              <div className="font-extrabold text-xs uppercase tracking-wider opacity-60 mb-1">
                Bill Summary
              </div>
              <div className="flex justify-between">
                <span className="opacity-75">Item Total</span>
                <span className="font-bold">₹{quote.itemTotal}</span>
              </div>
              {quote.couponDiscount > 0 && (
                <div className="flex justify-between text-emerald-400">
                  <span>Coupon Discount ({quote.couponCode})</span>
                  <span className="font-bold">-₹{quote.couponDiscount}</span>
                </div>
              )}
              {quote.goldDiscount > 0 && (
                <div className="flex justify-between text-amber-400">
                  <span>{theme.membershipName} 5% Privilege</span>
                  <span className="font-bold">-₹{quote.goldDiscount}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="opacity-75">Delivery Partner Fee</span>
                <span>
                  {quote.deliveryFee === 0 ? (
                    <span className="text-emerald-400 font-bold">FREE</span>
                  ) : (
                    `₹${quote.deliveryFee}`
                  )}
                </span>
              </div>
              <div className="flex justify-between opacity-75">
                <span>GST & Restaurant Packaging</span>
                <span>₹{quote.gstAndCharges}</span>
              </div>
              <div className="flex justify-between opacity-75">
                <span>Platform Fee</span>
                <span>₹{quote.platformFee}</span>
              </div>
              {quote.riderTip > 0 && (
                <div className="flex justify-between opacity-75">
                  <span>Delivery Valet Tip</span>
                  <span>₹{quote.riderTip}</span>
                </div>
              )}
              {quote.lockAdjustment > 0 && (
                <div
                  data-testid="cart-lock-adjustment"
                  className="flex justify-between font-bold text-emerald-400"
                >
                  <span>Price lock held</span>
                  <span>−₹{quote.lockAdjustment}</span>
                </div>
              )}
              <div className="border-t border-current/10 pt-2.5 flex justify-between text-sm font-black">
                <span>To Pay</span>
                <span data-testid="cart-grand-total" style={{ color: theme.primaryHex }}>
                  ₹{quote.grandTotal}
                </span>
              </div>
              {priceLockExpiresAt && (
                <p data-testid="cart-lock-note" className="text-[10px] opacity-60">
                  This price is held until {new Date(priceLockExpiresAt).toLocaleTimeString()}. If
                  it drops before you pay, you pay the lower price.
                </p>
              )}
              {quote.totalSavings > 0 && (
                <div className="p-2 rounded-xl bg-emerald-500/15 text-emerald-300 font-bold text-center text-[11px]">
                  🎉 You are saving ₹{quote.totalSavings} on this order!
                </div>
              )}
            </div>

            {/* ZPayKit Payment Bridge Simulator (zpaykit/js/v4/hook.js) */}
            <div
              className={`p-4 rounded-2xl border space-y-3 ${
                isDark ? "bg-[#141A26] border-white/10" : "bg-slate-50 border-slate-200"
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-extrabold flex items-center gap-1.5">
                  <CreditCard className="w-4 h-4" style={{ color: theme.primaryHex }} />
                  Demo Payment
                </span>
                <span className="text-[10px] font-mono opacity-60 flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  No payment collected
                </span>
              </div>

              <div className="space-y-1.5">
                {DEMO_PAYMENT_METHODS.map((method) => (
                  <button
                    key={method}
                    type="button"
                    onClick={() => handleSelectPaymentMethod(method)}
                    className={`w-full flex items-center justify-between p-2.5 rounded-xl border text-xs transition ${
                      selectedPayment === method
                        ? "border-emerald-400 bg-emerald-500/15 font-bold"
                        : isDark
                        ? "border-white/10 bg-white/5"
                        : "border-slate-200 bg-white"
                    }`}
                  >
                    <span>{method}</span>
                    {selectedPayment === method && (
                      <span className="text-[10px] text-emerald-400 font-semibold">
                        SELECTED
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </fieldset>
        )}

        {/* Drawer Footer CTA */}
        {items.length > 0 && (
          <div className="p-5 border-t border-current/10">
            {checkoutError && <p role="alert" className="text-sm text-rose-400 mb-3">{checkoutError}</p>}
            {allergyNoteMissing && (
              <p role="alert" className="text-sm text-rose-400 mb-3">
                Add the allergy details before ordering.
              </p>
            )}
            <button
              type="button"
              onClick={handleTriggerZPayCheckout}
              data-testid="place-order-zpaykit-btn"
              disabled={checkoutPending || hasUnavailableItem || allergyNoteMissing || scheduledSlotProblem !== null}
              aria-busy={checkoutPending}
              className="w-full py-3.5 px-5 rounded-2xl text-sm font-black text-white shadow-xl flex items-center justify-between transition hover:opacity-95 disabled:opacity-50"
              style={{ backgroundColor: theme.primaryHex }}
            >
              <div>
                <div className="text-left text-xs opacity-85">
                  TOTAL ₹{quote.grandTotal}
                </div>
                <div className="text-left text-sm font-black">
                  {checkoutPending ? "Confirming..." : "Place Demo Order"}
                </div>
              </div>
              <span className="flex items-center gap-1.5">
                <span>₹{quote.grandTotal}</span>
                <ArrowRight className="w-4 h-4" />
              </span>
            </button>
          </div>
        )}
      </div>
    </dialog>
  );
}
