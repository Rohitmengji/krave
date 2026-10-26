"use client";

import { useReducer, useRef } from "react";
import { useRouter } from "next/navigation";
import { OverlayDialog } from "@/components/OverlayDialog";
import { newId } from "@/lib/ids";
import {
  cartReducer,
  checkoutFlowReducer,
  MAX_NOTE_LENGTH,
  rememberOrder,
  reviewCheckout,
  type Cart,
  type CheckoutCharges,
  type CustomerDetails,
  type PricedCart,
} from "@/lib/managedCart";
import { cartStore, customerDetailsStore, recentOrdersStore } from "@/lib/managedOrderingStores";
import { FULFILMENT_LABELS, formatPaise, MAX_LINE_QUANTITY, type OrderTotals } from "@/lib/managedOrders";

const SUBMIT_TIMEOUT_MS = 20_000;

type CheckoutDialogProps = {
  isOpen: boolean;
  onClose: () => void;
  slug: string;
  restaurantName: string;
  restaurantPhone: string | null;
  cart: Cart;
  priced: PricedCart;
  details: CustomerDetails;
  charges: CheckoutCharges;
};

type OrderReply = {
  status?: string;
  code?: string;
  message?: string;
  quote?: OrderTotals;
  order?: { id: string; orderNumber: number; placedAt: string };
};

export function ManagedCheckoutDialog(props: CheckoutDialogProps) {
  const [flow, dispatchFlow] = useReducer(checkoutFlowReducer, { status: "editing" });
  const inFlight = useRef(false);
  const router = useRouter();
  const { slug, cart, priced, details, charges } = props;
  const store = cartStore(slug);
  const review = reviewCheckout(priced, details, charges);
  const submitting = flow.status === "submitting";

  function updateCart(action: Parameters<typeof cartReducer>[1]) {
    store.set((current) => cartReducer(current, action));
    dispatchFlow({ type: "edit" });
  }

  function updateDetails(patch: Partial<CustomerDetails>) {
    customerDetailsStore.set((current) => ({ ...current, ...patch }));
    store.set((current) => cartReducer(current, { type: "detailsChanged" }));
    dispatchFlow({ type: "edit" });
  }

  async function placeOrder() {
    // A ref, not only the disabled button: Enter and a click can both land before React
    // re-renders the button as disabled.
    if (inFlight.current) return;
    if (review.blocker || !review.totals || !review.fulfilment) {
      dispatchFlow({ type: "fail", message: review.blocker ?? "Check your order details." });
      return;
    }
    inFlight.current = true;
    dispatchFlow({ type: "submit" });
    const key = store.set((current) => cartReducer(current, { type: "beginCheckout", key: newId() })).checkoutKey;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SUBMIT_TIMEOUT_MS);
    try {
      const response = await fetch(`/api/public/restaurants/${encodeURIComponent(slug)}/orders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          idempotencyKey: key,
          customerName: details.name,
          customerPhone: details.phone,
          fulfilment: review.fulfilment,
          deliveryAddress: review.fulfilment === "delivery" ? details.address : null,
          serviceArea: review.fulfilment === "delivery" ? details.serviceArea : null,
          note: cart.note,
          lines: cart.lines,
          expectedTotalPaise: review.totals.totalPaise,
        }),
      });
      const reply = (await response.json().catch(() => ({}))) as OrderReply;
      if (response.ok && reply.order) {
        const placed = reply.order;
        recentOrdersStore.set((orders) =>
          rememberOrder(orders, {
            id: placed.id,
            slug,
            restaurantName: props.restaurantName,
            orderNumber: placed.orderNumber,
            placedAt: placed.placedAt,
          })
        );
        store.set(cartReducer(cart, { type: "clear" }));
        router.push(`/r/${encodeURIComponent(slug)}/orders/${encodeURIComponent(placed.id)}`);
        return;
      }
      if (response.status === 409 && reply.code === "conflict") {
        // The key was used for a different cart (another tab). Start a fresh attempt.
        store.set((current) => cartReducer(current, { type: "detailsChanged" }));
      }
      if (response.status === 409 || reply.code === "closed") {
        // Prices, availability or opening state changed: reload the menu from the server.
        router.refresh();
      }
      const quote = reply.code === "price_changed" && reply.quote ? ` New total: ${formatPaise(reply.quote.totalPaise)}.` : "";
      dispatchFlow({
        type: "fail",
        message:
          response.status >= 500 || !reply.message
            ? "We could not confirm your order. Try again; it will not be placed twice."
            : `${reply.message}${quote}`,
      });
    } catch {
      dispatchFlow({
        type: "fail",
        message: controller.signal.aborted
          ? "The restaurant took too long to respond. Try again; your order will not be placed twice."
          : "You seem to be offline. Check your connection and try again; your order will not be placed twice.",
      });
    } finally {
      clearTimeout(timer);
      inFlight.current = false;
    }
  }

  const fieldClass =
    "mt-1 w-full rounded-xl border border-[#c9d0c7] bg-white px-3 py-2.5 text-base focus-visible:outline-2 focus-visible:outline-emerald-800";

  return (
    <OverlayDialog
      isOpen={props.isOpen}
      onClose={props.onClose}
      onDismiss={() => {
        if (!inFlight.current) props.onClose();
      }}
      label="Your order"
      testId="managed-checkout"
      className="m-auto w-full max-w-xl bg-transparent p-3 backdrop:bg-black/70"
    >
      <form
        className="max-h-[90dvh] space-y-5 overflow-y-auto rounded-2xl bg-white p-5 text-[#1d2922] shadow-xl sm:p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void placeOrder();
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-xl font-extrabold">Your order from {props.restaurantName}</h2>
          <button
            type="button"
            onClick={props.onClose}
            disabled={submitting}
            className="min-h-11 rounded-xl px-3 font-bold text-slate-700 hover:bg-slate-100"
          >
            Close
          </button>
        </div>

        {cart.checkoutKey && flow.status === "editing" ? (
          <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950">
            Your last attempt to place this order did not finish. Placing it again with the same details will not
            create a second order.
          </p>
        ) : null}

        {priced.lines.length === 0 ? (
          <p className="text-slate-600">Your cart is empty.</p>
        ) : (
          <ul className="divide-y divide-[#e3e7e1]" aria-label="Dishes in your order">
            {priced.lines.map((line) => (
              <li key={line.key} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className={line.item ? "font-semibold" : "font-semibold text-red-800"}>{line.label}</p>
                  <p className="text-sm text-slate-600">
                    {line.unitPricePaise === null ? "No longer available" : `${formatPaise(line.unitPricePaise)} each`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {line.item ? (
                    <>
                      <button
                        type="button"
                        aria-label={`One less ${line.label}`}
                        onClick={() => updateCart({ type: "setQuantity", key: line.key, quantity: line.line.quantity - 1 })}
                        disabled={submitting}
                        className="size-11 rounded-full border border-[#d9ded7] text-lg font-bold"
                      >
                        −
                      </button>
                      <span className="w-6 text-center font-bold" aria-label={`Quantity ${line.line.quantity}`}>
                        {line.line.quantity}
                      </span>
                      <button
                        type="button"
                        aria-label={`One more ${line.label}`}
                        onClick={() => updateCart({ type: "setQuantity", key: line.key, quantity: line.line.quantity + 1 })}
                        disabled={submitting || line.line.quantity >= MAX_LINE_QUANTITY}
                        className="size-11 rounded-full border border-[#d9ded7] text-lg font-bold disabled:opacity-40"
                      >
                        +
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={() => updateCart({ type: "remove", key: line.key })}
                      disabled={submitting}
                      className="min-h-11 rounded-xl border border-red-300 px-3 font-bold text-red-800"
                    >
                      Remove
                    </button>
                  )}
                  <span className="w-20 text-right font-bold">{formatPaise(line.lineTotalPaise)}</span>
                </div>
              </li>
            ))}
          </ul>
        )}

        <fieldset disabled={submitting} className="space-y-4">
          {charges.fulfilments.length > 1 ? (
            <div>
              <p id="fulfilment-label" className="font-bold">How do you want it?</p>
              <div role="radiogroup" aria-labelledby="fulfilment-label" className="mt-2 flex flex-wrap gap-2">
                {charges.fulfilments.map((option) => (
                  <label
                    key={option}
                    className="flex min-h-11 items-center gap-2 rounded-xl border border-[#d9ded7] px-4 has-checked:border-emerald-800 has-checked:bg-emerald-50"
                  >
                    <input
                      type="radio"
                      name="fulfilment"
                      checked={review.fulfilment === option}
                      onChange={() => updateDetails({ fulfilment: option })}
                      className="size-4 accent-emerald-800"
                    />
                    {FULFILMENT_LABELS[option]}
                  </label>
                ))}
              </div>
            </div>
          ) : review.fulfilment ? (
            <p className="font-bold">{FULFILMENT_LABELS[review.fulfilment]}</p>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block font-semibold">
              Your name
              <input
                className={fieldClass}
                autoComplete="name"
                maxLength={80}
                value={details.name}
                onChange={(event) => updateDetails({ name: event.target.value })}
              />
            </label>
            <label className="block font-semibold">
              Phone number
              <input
                className={fieldClass}
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={20}
                value={details.phone}
                onChange={(event) => updateDetails({ phone: event.target.value })}
              />
            </label>
          </div>

          {review.fulfilment === "delivery" ? (
            <div className="grid gap-4">
              <label className="block font-semibold">
                Delivery area
                <select
                  className={fieldClass}
                  value={details.serviceArea}
                  onChange={(event) => updateDetails({ serviceArea: event.target.value })}
                >
                  <option value="">Choose your area</option>
                  {charges.serviceAreas.map((area) => (
                    <option key={area} value={area}>{area}</option>
                  ))}
                </select>
              </label>
              <label className="block font-semibold">
                Delivery address
                <textarea
                  className={fieldClass}
                  autoComplete="street-address"
                  rows={2}
                  maxLength={300}
                  value={details.address}
                  onChange={(event) => updateDetails({ address: event.target.value })}
                />
              </label>
            </div>
          ) : null}

          <label className="block font-semibold">
            Note for the kitchen <span className="font-normal text-slate-600">(optional)</span>
            <textarea
              className={fieldClass}
              rows={2}
              maxLength={MAX_NOTE_LENGTH}
              value={cart.note}
              onChange={(event) => updateCart({ type: "setNote", note: event.target.value })}
            />
          </label>
          <p className="text-xs text-slate-600">Your name, phone and address are remembered on this device for next time.</p>
        </fieldset>

        {review.totals ? (
          <dl className="space-y-1 rounded-xl bg-[#f7f5ef] p-4 text-sm">
            <div className="flex justify-between"><dt>Food</dt><dd>{formatPaise(review.totals.subtotalPaise)}</dd></div>
            {review.totals.deliveryFeePaise > 0 ? (
              <div className="flex justify-between"><dt>Delivery fee</dt><dd>{formatPaise(review.totals.deliveryFeePaise)}</dd></div>
            ) : null}
            {review.totals.taxPaise > 0 ? (
              <div className="flex justify-between">
                <dt>Tax ({charges.taxRateBps / 100}%)</dt>
                <dd>{formatPaise(review.totals.taxPaise)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-[#d9ded7] pt-2 text-base font-extrabold">
              <dt>Total</dt>
              <dd data-testid="checkout-total">{formatPaise(review.totals.totalPaise)}</dd>
            </div>
            <p className="pt-1 text-slate-600">
              {review.fulfilment === "delivery"
                ? "Pay on delivery, by cash or UPI."
                : "Pay at the restaurant, by cash or UPI."}{" "}
              No payment is taken online.
            </p>
          </dl>
        ) : null}
        {review.fulfilment === "delivery" && charges.minimumOrderPaise > 0 ? (
          <p className="text-sm text-slate-600">Minimum order for delivery: {formatPaise(charges.minimumOrderPaise)}.</p>
        ) : null}

        <div role="alert" className="text-sm font-semibold text-red-800 empty:hidden">
          {flow.status === "failed" ? flow.message : null}
        </div>
        {flow.status === "failed" && props.restaurantPhone ? (
          <p className="text-sm">
            Or call <a className="font-bold text-emerald-900 underline" href={`tel:${props.restaurantPhone}`}>{props.restaurantPhone}</a>.
          </p>
        ) : null}

        <button
          type="submit"
          disabled={submitting || priced.lines.length === 0}
          aria-disabled={Boolean(review.blocker)}
          className="min-h-12 w-full rounded-xl bg-emerald-800 px-5 text-lg font-extrabold text-white hover:bg-emerald-700 disabled:opacity-60 aria-disabled:bg-emerald-800/60"
        >
          {submitting
            ? "Placing order…"
            : review.totals
              ? `Place order · ${formatPaise(review.totals.totalPaise)}`
              : "Place order"}
        </button>
        {review.blocker && flow.status !== "failed" ? (
          <p className="text-center text-sm text-slate-600">{review.blocker}</p>
        ) : null}
      </form>
    </OverlayDialog>
  );
}
