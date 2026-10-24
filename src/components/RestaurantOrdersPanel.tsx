"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { OverlayDialog } from "@/components/OverlayDialog";
import {
  formatPaise,
  FULFILMENT_LABELS,
  ORDER_STATUS_LABELS,
  OWNER_ORDER_TRANSITIONS,
  type RestaurantOrderStatus,
} from "@/lib/managedOrders";
import {
  initialOwnerOrders,
  ownerOrdersReducer,
  type OwnerOrder,
  type OwnerOrderView,
} from "@/lib/ownerOrders";

/** Short enough that a new order shows on every waiter's screen without a refresh. */
const POLL_MS = 2_000;

const ACTION_LABELS: Partial<Record<RestaurantOrderStatus, string>> = {
  accepted: "Accept",
  rejected: "Reject",
  preparing: "Start preparing",
  ready: "Mark ready",
  completed: "Complete",
  cancelled: "Cancel order",
};

const VIEW_LABELS: Record<OwnerOrderView, string> = { active: "Active", done: "Finished", all: "All" };

type OrdersReply = { orders?: OwnerOrder[]; nextCursor?: string | null; message?: string };

async function readJson<T>(response: Response): Promise<T> {
  return (await response.json().catch(() => ({}))) as T;
}

/** The kitchen's live order queue for one restaurant. */
export function RestaurantOrdersPanel({ restaurantId, acceptingOrders }: { restaurantId: string; acceptingOrders: boolean }) {
  const [state, dispatch] = useReducer(ownerOrdersReducer, initialOwnerOrders);
  const [closing, setClosing] = useState<{ order: OwnerOrder; to: "rejected" | "cancelled" } | null>(null);
  const [reason, setReason] = useState("");
  const pending = useRef(new Set<string>());
  const base = `/api/owner/${encodeURIComponent(restaurantId)}/orders`;
  const { view, request } = state;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | null = null;
    let stopped = false;

    async function load(poll: boolean) {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch(`${base}?view=${view}`, { cache: "no-store", signal: controller.signal });
        const reply = await readJson<OrdersReply>(response);
        if (!response.ok || !reply.orders) throw new Error(reply.message ?? "Orders could not be loaded.");
        dispatch({ type: "loaded", request, orders: reply.orders, nextCursor: reply.nextCursor ?? null, poll });
      } catch (error) {
        if ((error as Error).name === "AbortError") return;
        dispatch({ type: "loadFailed", request, poll, message: (error as Error).message || "Orders could not be loaded." });
      }
      // Only the live queue polls; history pages are loaded on request.
      if (!stopped && view === "active" && document.visibilityState === "visible") {
        timer = setTimeout(() => void load(true), POLL_MS);
      }
    }

    function onVisibility() {
      clearTimeout(timer);
      if (document.visibilityState === "visible" && view === "active") void load(true);
    }

    void load(false);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [base, view, request]);

  async function loadMore() {
    if (!state.nextCursor || state.loadingMore) return;
    dispatch({ type: "loadingMore" });
    try {
      const response = await fetch(`${base}?view=${view}&before=${encodeURIComponent(state.nextCursor)}`, { cache: "no-store" });
      const reply = await readJson<OrdersReply>(response);
      if (!response.ok || !reply.orders) throw new Error(reply.message ?? "Older orders could not be loaded.");
      dispatch({ type: "more", request, orders: reply.orders, nextCursor: reply.nextCursor ?? null });
    } catch (error) {
      dispatch({ type: "moreFailed", request, message: (error as Error).message || "Older orders could not be loaded." });
    }
  }

  async function changeStatus(order: OwnerOrder, to: RestaurantOrderStatus, why?: string) {
    if (pending.current.has(order.id)) return;
    pending.current.add(order.id);
    dispatch({ type: "changing", id: order.id });
    try {
      const response = await fetch(base, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId: order.id, from: order.status, to, reason: why || undefined }),
      });
      const reply = await readJson<{ order?: OwnerOrder; message?: string }>(response);
      if (response.ok && reply.order) {
        dispatch({ type: "changed", order: reply.order });
      } else {
        dispatch({ type: "changeFailed", id: order.id, message: reply.message ?? "The order could not be updated." });
        // Changed elsewhere (another device, or the customer cancelled): show the truth.
        if (response.status === 409) dispatch({ type: "reload" });
      }
    } catch {
      dispatch({ type: "changeFailed", id: order.id, message: "You seem to be offline. The order was not changed." });
    } finally {
      pending.current.delete(order.id);
    }
  }

  return (
    <section aria-labelledby="orders-heading" className="space-y-4 rounded-2xl border border-white/10 bg-[#121721] p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="orders-heading" className="text-xl font-bold">Orders</h2>
          <p className="mt-1 text-sm text-slate-400">
            {acceptingOrders
              ? "Customers can order from your public menu. Payment is collected at the restaurant or on delivery."
              : "Online ordering is switched off. Turn it on under Online ordering when you are ready."}
          </p>
        </div>
        <div role="group" aria-label="Show orders" className="flex gap-1 rounded-xl border border-white/15 p-1">
          {(Object.keys(VIEW_LABELS) as OwnerOrderView[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => dispatch({ type: "view", view: option })}
              className="min-h-10 rounded-lg px-3 text-sm font-bold aria-pressed:bg-emerald-600 aria-pressed:text-white"
            >
              {VIEW_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      <p role="status" aria-live="polite" className="sr-only">{state.announcement}</p>
      {state.error && state.load === "ready" ? <p role="alert" className="text-sm text-red-200">{state.error}</p> : null}

      {state.load === "loading" ? (
        <p className="text-slate-400">Loading orders…</p>
      ) : state.load === "error" ? (
        <div role="alert" className="space-y-2">
          <p className="text-red-200">{state.error}</p>
          <button type="button" onClick={() => dispatch({ type: "reload" })} className="rounded-xl border border-white/20 px-4 py-2 font-bold">
            Try again
          </button>
        </div>
      ) : state.orders.length === 0 ? (
        <p className="text-slate-400">{view === "active" ? "No orders waiting. New orders appear here automatically." : "No orders yet."}</p>
      ) : (
        <ul className="space-y-3">
          {state.orders.map((order) => (
            <OrderCard
              key={order.id}
              order={order}
              busy={state.pending.includes(order.id)}
              onChange={(to) => {
                if (to === "rejected" || to === "cancelled") {
                  setReason("");
                  setClosing({ order, to });
                } else {
                  void changeStatus(order, to);
                }
              }}
            />
          ))}
        </ul>
      )}

      {state.nextCursor ? (
        <button
          type="button"
          onClick={() => void loadMore()}
          disabled={state.loadingMore}
          className="rounded-xl border border-white/20 px-4 py-2 font-bold disabled:opacity-50"
        >
          {state.loadingMore ? "Loading…" : "Load older orders"}
        </button>
      ) : null}

      <OverlayDialog
        isOpen={closing !== null}
        onClose={() => setClosing(null)}
        label={closing?.to === "rejected" ? "Reject order" : "Cancel order"}
      >
        {closing ? (
          <form
            className="space-y-4 rounded-2xl border border-white/10 bg-[#121721] p-6 text-slate-100"
            onSubmit={(event) => {
              event.preventDefault();
              const target = closing;
              setClosing(null);
              void changeStatus(target.order, target.to, reason.trim());
            }}
          >
            <h2 className="text-lg font-bold">
              {closing.to === "rejected" ? "Reject" : "Cancel"} order #{closing.order.orderNumber}?
            </h2>
            <label className="block text-sm font-semibold">
              Reason shown to the customer (optional)
              <input
                value={reason}
                maxLength={200}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. Kitchen closing early"
                className="field"
              />
            </label>
            <div className="flex justify-end gap-3">
              <button type="button" onClick={() => setClosing(null)} className="rounded-xl px-4 py-2 font-bold">
                Keep order
              </button>
              <button className="rounded-xl bg-red-700 px-4 py-2 font-bold text-white">
                {closing.to === "rejected" ? "Reject order" : "Cancel order"}
              </button>
            </div>
          </form>
        ) : null}
      </OverlayDialog>
    </section>
  );
}

function OrderCard({ order, busy, onChange }: { order: OwnerOrder; busy: boolean; onChange: (to: RestaurantOrderStatus) => void }) {
  const actions = OWNER_ORDER_TRANSITIONS[order.status];
  return (
    <li
      data-testid={`owner-order-${order.orderNumber}`}
      className={`rounded-xl border p-4 ${order.status === "placed" ? "border-amber-300/50 bg-amber-950/20" : "border-white/10 bg-[#0a0d12]"}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-extrabold">
            #{order.orderNumber} · {FULFILMENT_LABELS[order.fulfilment]}
          </h3>
          <p className="text-sm text-slate-400">
            {new Date(order.placedAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" })}
          </p>
        </div>
        <span className="rounded-full border border-white/20 px-3 py-1 text-xs font-bold uppercase" data-testid="owner-order-status">
          {ORDER_STATUS_LABELS[order.status]}
        </span>
      </div>
      <p className="mt-2">
        <span className="font-semibold">{order.customerName}</span> ·{" "}
        <a className="text-emerald-300 underline" href={`tel:${order.customerPhone}`}>{order.customerPhone}</a>
      </p>
      {order.deliveryAddress ? (
        <p className="text-sm text-slate-300">
          {order.deliveryAddress}
          {order.serviceArea ? ` (${order.serviceArea})` : ""}
        </p>
      ) : null}
      <ul className="mt-2 text-sm">
        {order.lines.map((line) => (
          <li key={line.lineNo} className="flex justify-between gap-3">
            <span>
              {line.quantity} × {[line.itemName, line.variantName, ...line.addons.map((addon) => addon.name)].filter(Boolean).join(" · ")}
            </span>
            <span>{formatPaise(line.lineTotalPaise)}</span>
          </li>
        ))}
      </ul>
      {order.note ? <p className="mt-2 rounded-lg bg-white/5 p-2 text-sm">Note: {order.note}</p> : null}
      <p className="mt-2 font-bold">
        Total {formatPaise(order.totalPaise)} ·{" "}
        <span className="font-normal text-slate-400">{order.paymentMethod === "pay_on_delivery" ? "collect on delivery" : "collect at counter"}</span>
      </p>
      {order.statusReason ? <p className="text-sm text-slate-400">Reason: {order.statusReason}</p> : null}
      {actions.length ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {actions.map((to) => (
            <button
              key={to}
              type="button"
              disabled={busy}
              onClick={() => onChange(to)}
              className={`min-h-11 rounded-xl px-4 font-bold disabled:opacity-50 ${
                to === "rejected" || to === "cancelled" ? "border border-red-400/50 text-red-200" : "bg-emerald-600 text-white"
              }`}
            >
              {ACTION_LABELS[to]} <span className="sr-only">order #{order.orderNumber}</span>
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}
