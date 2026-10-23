"use client";

import { useEffect, useReducer, useRef } from "react";
import Link from "next/link";
import type { PublicRestaurantOrder } from "@/lib/server/restaurantOrderStore";
import {
  customerCanCancel,
  formatPaise,
  FULFILMENT_LABELS,
  isTerminalOrderStatus,
  ORDER_STATUS_LABELS,
} from "@/lib/managedOrders";

const POLL_MS = 10_000;

type StatusState = {
  order: PublicRestaurantOrder;
  cancel: { status: "idle" } | { status: "confirming" } | { status: "cancelling" } | { status: "failed"; message: string };
  stale: boolean;
};

type StatusAction =
  | { type: "loaded"; order: PublicRestaurantOrder }
  | { type: "stale" }
  | { type: "askCancel" }
  | { type: "keep" }
  | { type: "cancelling" }
  | { type: "cancelFailed"; message: string };

function statusReducer(state: StatusState, action: StatusAction): StatusState {
  switch (action.type) {
    case "loaded":
      // Never step backwards: a slow poll that started before a cancel must not undo it.
      if (action.order.updatedAt < state.order.updatedAt) return { ...state, stale: false };
      return {
        order: action.order,
        stale: false,
        cancel: customerCanCancel(action.order.status) ? state.cancel : { status: "idle" },
      };
    case "stale":
      return { ...state, stale: true };
    case "askCancel":
      return { ...state, cancel: { status: "confirming" } };
    case "keep":
      return { ...state, cancel: { status: "idle" } };
    case "cancelling":
      return { ...state, cancel: { status: "cancelling" } };
    case "cancelFailed":
      return { ...state, cancel: { status: "failed", message: action.message } };
  }
}

const STEPS = ["placed", "accepted", "preparing", "ready", "completed"] as const;

export function ManagedOrderStatus({ initialOrder }: { initialOrder: PublicRestaurantOrder }) {
  const [state, dispatch] = useReducer(statusReducer, { order: initialOrder, cancel: { status: "idle" }, stale: false });
  const { order } = state;
  const terminal = isTerminalOrderStatus(order.status);
  const cancelling = useRef(false);

  useEffect(() => {
    if (terminal) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let stopped = false;

    async function poll() {
      if (document.visibilityState !== "visible") return;
      controller = new AbortController();
      try {
        const response = await fetch(`/api/public/orders/${encodeURIComponent(order.id)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const reply = (await response.json()) as { order?: PublicRestaurantOrder };
        if (!response.ok || !reply.order) throw new Error("status unavailable");
        dispatch({ type: "loaded", order: reply.order });
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        dispatch({ type: "stale" });
      }
      if (!stopped) timer = setTimeout(poll, POLL_MS);
    }

    function onVisibility() {
      clearTimeout(timer);
      controller?.abort();
      if (document.visibilityState === "visible") void poll();
    }

    timer = setTimeout(poll, POLL_MS);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [order.id, terminal]);

  async function cancelOrder() {
    if (cancelling.current) return;
    cancelling.current = true;
    dispatch({ type: "cancelling" });
    try {
      const response = await fetch(`/api/public/orders/${encodeURIComponent(order.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      const reply = (await response.json().catch(() => ({}))) as { order?: PublicRestaurantOrder; message?: string };
      if (response.ok && reply.order) {
        dispatch({ type: "loaded", order: reply.order });
      } else {
        dispatch({ type: "cancelFailed", message: reply.message ?? "The order could not be cancelled. Please call the restaurant." });
        // It may have been accepted meanwhile; show the current state.
        const latest = await fetch(`/api/public/orders/${encodeURIComponent(order.id)}`, { cache: "no-store" });
        const current = (await latest.json().catch(() => ({}))) as { order?: PublicRestaurantOrder };
        if (current.order) dispatch({ type: "loaded", order: current.order });
      }
    } catch {
      dispatch({ type: "cancelFailed", message: "You seem to be offline. Try again or call the restaurant." });
    } finally {
      cancelling.current = false;
    }
  }

  const reached = STEPS.indexOf(order.status as (typeof STEPS)[number]);
  const phone = order.restaurant.phone;

  return (
    <div className="space-y-6">
      <section className="rounded-2xl bg-white p-5 shadow-sm sm:p-6" aria-labelledby="order-heading">
        <p className="text-sm font-bold uppercase tracking-widest text-emerald-800">{order.restaurant.name}</p>
        <h1 id="order-heading" className="mt-1 text-3xl font-black">Order #{order.orderNumber}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {FULFILMENT_LABELS[order.fulfilment]} · placed{" "}
          {new Date(order.placedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}
        </p>
        <p role="status" aria-live="polite" className="mt-4 text-xl font-extrabold" data-testid="order-status">
          {ORDER_STATUS_LABELS[order.status]}
        </p>
        {order.statusReason ? <p className="mt-1 text-slate-700">Reason: {order.statusReason}</p> : null}
        {reached >= 0 ? (
          <ol className="mt-4 grid grid-cols-5 gap-1" aria-label="Order progress">
            {STEPS.map((step, index) => (
              <li key={step} className="text-center text-xs">
                <span
                  className={`block h-2 rounded-full ${index <= reached ? "bg-emerald-700" : "bg-slate-200"}`}
                  aria-hidden="true"
                />
                <span className={index <= reached ? "font-semibold" : "text-slate-500"}>
                  {ORDER_STATUS_LABELS[step]}
                  <span className="sr-only">{index <= reached ? " (done)" : ""}</span>
                </span>
              </li>
            ))}
          </ol>
        ) : null}
        {state.stale && !terminal ? (
          <p className="mt-3 text-sm text-amber-900">Could not refresh the status. Retrying…</p>
        ) : null}
        {!terminal ? <p className="mt-3 text-sm text-slate-600">This page updates by itself.</p> : null}
      </section>

      <section className="rounded-2xl bg-white p-5 shadow-sm sm:p-6" aria-labelledby="items-heading">
        <h2 id="items-heading" className="text-lg font-extrabold">Items</h2>
        <ul className="mt-2 divide-y divide-[#e3e7e1]">
          {order.lines.map((line) => (
            <li key={line.lineNo} className="flex justify-between gap-3 py-2">
              <span>
                {line.quantity} × {[line.itemName, line.variantName, ...line.addons.map((addon) => addon.name)].filter(Boolean).join(" · ")}
              </span>
              <span className="font-semibold">{formatPaise(line.lineTotalPaise)}</span>
            </li>
          ))}
        </ul>
        <dl className="mt-3 space-y-1 border-t border-[#d9ded7] pt-3 text-sm">
          <div className="flex justify-between"><dt>Food</dt><dd>{formatPaise(order.subtotalPaise)}</dd></div>
          {order.deliveryFeePaise > 0 ? (
            <div className="flex justify-between"><dt>Delivery fee</dt><dd>{formatPaise(order.deliveryFeePaise)}</dd></div>
          ) : null}
          {order.taxPaise > 0 ? (
            <div className="flex justify-between"><dt>Tax</dt><dd>{formatPaise(order.taxPaise)}</dd></div>
          ) : null}
          <div className="flex justify-between text-base font-extrabold"><dt>Total</dt><dd>{formatPaise(order.totalPaise)}</dd></div>
        </dl>
        <p className="mt-2 text-sm text-slate-600">
          {order.paymentMethod === "pay_on_delivery" ? "Pay on delivery" : "Pay at the restaurant"}, by cash or UPI.
        </p>
      </section>

      <div className="flex flex-wrap gap-3">
        {phone ? (
          <a href={`tel:${phone}`} className="min-h-11 content-center rounded-xl bg-emerald-800 px-5 font-bold text-white hover:bg-emerald-700">
            Call the restaurant
          </a>
        ) : null}
        <Link
          href={`/r/${encodeURIComponent(order.restaurant.slug)}`}
          className="min-h-11 content-center rounded-xl border border-[#c9d0c7] bg-white px-5 font-bold hover:bg-slate-50"
        >
          Back to menu
        </Link>
        {customerCanCancel(order.status) && state.cancel.status !== "confirming" ? (
          <button
            type="button"
            onClick={() => dispatch({ type: "askCancel" })}
            disabled={state.cancel.status === "cancelling"}
            className="min-h-11 rounded-xl border border-red-300 bg-white px-5 font-bold text-red-800 hover:bg-red-50"
          >
            {state.cancel.status === "cancelling" ? "Cancelling…" : "Cancel order"}
          </button>
        ) : null}
      </div>

      {state.cancel.status === "confirming" ? (
        <div role="alertdialog" aria-labelledby="cancel-q" className="rounded-2xl border border-red-200 bg-red-50 p-4">
          <p id="cancel-q" className="font-bold">Cancel order #{order.orderNumber}?</p>
          <div className="mt-3 flex gap-3">
            <button
              type="button"
              autoFocus
              onClick={() => void cancelOrder()}
              className="min-h-11 rounded-xl bg-red-800 px-5 font-bold text-white hover:bg-red-700"
            >
              Yes, cancel
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "keep" })}
              className="min-h-11 rounded-xl border border-[#c9d0c7] bg-white px-5 font-bold"
            >
              Keep order
            </button>
          </div>
        </div>
      ) : null}
      {state.cancel.status === "failed" ? <p role="alert" className="font-semibold text-red-800">{state.cancel.message}</p> : null}
    </div>
  );
}
