"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import Image from "next/image";
import Link from "next/link";
import { ManagedCheckoutDialog } from "@/components/ManagedCheckoutDialog";
import { MenuItemChooser } from "@/components/MenuItemChooser";
import { cartReducer, priceCart, type CartLine, type CheckoutCharges, type OrderableItem } from "@/lib/managedCart";
import {
  cartStore,
  customerDetailsStore,
  orderingStorageWarning,
  recentOrdersStore,
} from "@/lib/managedOrderingStores";
import { formatPaise, unitPricePaise } from "@/lib/managedOrders";

export interface MenuDisplayItem extends OrderableItem {
  description: string;
  portionSize: string;
  imageUrl: string | null;
}

export interface MenuDisplayCategory {
  id: string;
  name: string;
  items: MenuDisplayItem[];
}

type ManagedMenuOrderingProps = {
  slug: string;
  restaurantName: string;
  restaurantPhone: string | null;
  /** Null when ordering is open; otherwise why it is not, for the customer. */
  closedReason: string | null;
  charges: CheckoutCharges;
  categories: MenuDisplayCategory[];
};

const noSubscribe = () => () => {};

export function ManagedMenuOrdering({
  slug,
  restaurantName,
  restaurantPhone,
  closedReason,
  charges,
  categories,
}: ManagedMenuOrderingProps) {
  const store = cartStore(slug);
  const cart = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const details = useSyncExternalStore(
    customerDetailsStore.subscribe,
    customerDetailsStore.getSnapshot,
    customerDetailsStore.getServerSnapshot
  );
  const recentOrders = useSyncExternalStore(
    recentOrdersStore.subscribe,
    recentOrdersStore.getSnapshot,
    recentOrdersStore.getServerSnapshot
  );
  const storageWarning = useSyncExternalStore(
    orderingStorageWarning.subscribe,
    orderingStorageWarning.getSnapshot,
    () => null
  );
  // False on the server and during hydration, so the cart bar never renders mismatched HTML.
  const hydrated = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [choosing, setChoosing] = useState<OrderableItem | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [status, setStatus] = useState("");

  const items = useMemo(
    () => new Map(categories.flatMap((category) => category.items.map((item) => [item.id, item] as const))),
    [categories]
  );
  const priced = priceCart(cart, items);
  const ordering = closedReason === null;
  const myOrders = recentOrders.filter((order) => order.slug === slug).slice(0, 3);

  function add(line: CartLine, name: string) {
    const next = store.set((current) => cartReducer(current, { type: "add", line }));
    const count = next.lines.reduce((sum, entry) => sum + entry.quantity, 0);
    setStatus(`Added ${name}. ${count} ${count === 1 ? "item" : "items"} in your cart.`);
  }

  return (
    <>
      <p role="status" aria-live="polite" className="sr-only">{status}</p>

      {hydrated && myOrders.length ? (
        <section aria-labelledby="my-orders" className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4">
          <h2 id="my-orders" className="font-bold">Your recent orders</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {myOrders.map((order) => (
              <li key={order.id}>
                <Link
                  className="font-semibold text-emerald-900 underline"
                  href={`/r/${encodeURIComponent(slug)}/orders/${encodeURIComponent(order.id)}`}
                >
                  Order #{order.orderNumber} · track status
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {closedReason ? (
        <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4" aria-label="Ordering status">
          <p className="font-bold">{closedReason}</p>
          {restaurantPhone ? (
            <p className="mt-1 text-sm">
              Call <a className="font-bold text-emerald-900 underline" href={`tel:${restaurantPhone}`}>{restaurantPhone}</a> to order.
            </p>
          ) : null}
        </section>
      ) : null}

      {storageWarning ? <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950">{storageWarning}</p> : null}

      <div className="space-y-8">
        {categories.map((category) => (
          <section key={category.id} aria-labelledby={`category-${category.id}`}>
            <h2 id={`category-${category.id}`} className="border-b border-[#d9ded7] pb-3 text-2xl font-extrabold">
              {category.name}
            </h2>
            {category.items.length ? (
              <ul className="divide-y divide-[#d9ded7]">
                {category.items.map((item) => (
                  <MenuItemRow
                    key={item.id}
                    item={item}
                    ordering={ordering}
                    onAdd={() =>
                      item.variants.length || item.addons.length
                        ? setChoosing(item)
                        : add({ itemId: item.id, variantId: null, addonIds: [], quantity: 1 }, item.name)
                    }
                  />
                ))}
              </ul>
            ) : (
              <p className="py-4 text-sm text-slate-500">No dishes available in this category.</p>
            )}
          </section>
        ))}
      </div>

      {hydrated && ordering && priced.lines.length ? (
        <>
          <div className="h-20" aria-hidden="true" />
          <div className="fixed inset-x-0 bottom-0 z-20 border-t border-[#d9ded7] bg-white/95 p-3 shadow-[0_-4px_16px_rgba(0,0,0,.08)] backdrop-blur">
            <button
              type="button"
              onClick={() => setCheckoutOpen(true)}
              className="mx-auto flex min-h-12 w-full max-w-5xl items-center justify-between rounded-xl bg-emerald-800 px-5 font-extrabold text-white hover:bg-emerald-700"
            >
              <span>
                View order · {priced.itemCount} {priced.itemCount === 1 ? "item" : "items"}
              </span>
              <span>{formatPaise(priced.subtotalPaise)}</span>
            </button>
          </div>
        </>
      ) : null}

      <MenuItemChooser
        item={choosing}
        onClose={() => setChoosing(null)}
        onAdd={(line) => {
          const name = choosing?.name ?? "dish";
          setChoosing(null);
          add(line, name);
        }}
      />
      <ManagedCheckoutDialog
        isOpen={checkoutOpen && ordering}
        onClose={() => setCheckoutOpen(false)}
        slug={slug}
        restaurantName={restaurantName}
        restaurantPhone={restaurantPhone}
        cart={cart}
        priced={priced}
        details={details}
        charges={charges}
      />
    </>
  );
}

function MenuItemRow({ item, ordering, onAdd }: { item: MenuDisplayItem; ordering: boolean; onAdd: () => void }) {
  return (
    <li className="py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-4">
          {item.imageUrl ? (
            <Image
              src={item.imageUrl}
              alt={item.name}
              width={96}
              height={96}
              unoptimized
              className="size-24 shrink-0 rounded-xl object-cover"
            />
          ) : null}
          <div>
            <h3 className="font-bold">{item.name}</h3>
            {item.description ? <p className="mt-1 max-w-2xl text-sm text-slate-600">{item.description}</p> : null}
            {item.portionSize ? <p className="mt-1 text-xs text-slate-500">{item.portionSize}</p> : null}
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <p className="font-bold text-emerald-900">
            {item.discountedPricePaise !== null ? (
              <>
                <span>{formatPaise(item.discountedPricePaise)}</span>
                <span className="ml-2 text-sm font-normal text-slate-500 line-through">{formatPaise(item.pricePaise)}</span>
              </>
            ) : (
              formatPaise(item.pricePaise)
            )}
          </p>
          {ordering ? (
            <button
              type="button"
              onClick={onAdd}
              aria-label={`Add ${item.name}`}
              className="min-h-11 rounded-xl border-2 border-emerald-800 px-5 font-extrabold text-emerald-900 hover:bg-emerald-50"
            >
              Add
            </button>
          ) : null}
        </div>
      </div>
      {item.variants.length ? (
        <ul className="mt-3 space-y-1 text-sm text-slate-700" aria-label={`${item.name} portions`}>
          {item.variants.map((variant) => (
            <li key={variant.id} className="flex justify-between gap-3">
              <span>{variant.name}</span>
              <span>{formatPaise(unitPricePaise(item, variant.id, []) ?? 0)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {item.addons.length ? (
        <p className="mt-2 text-xs text-slate-600">
          Add-ons: {item.addons.map((addon) => `${addon.name} (+${formatPaise(addon.pricePaise)})`).join(", ")}
        </p>
      ) : null}
    </li>
  );
}
