import {
  parseCart,
  parseDetails,
  parseRecentOrders,
  serializeCart,
  serializeDetails,
  serializeRecentOrders,
  type Cart,
  type CustomerDetails,
  type RecentOrder,
} from "@/lib/managedCart";
import { createMemoryStore, createPersistedStore, type PersistedStore } from "@/lib/persistedStore";

/**
 * Browser stores for ordering from a restaurant's own menu (/r/[slug]). The cart is kept
 * per restaurant; the customer's details and recent orders are shared across them.
 */

export const orderingStorageWarning = createMemoryStore<string | null>(null);

function onWriteError() {
  orderingStorageWarning.set("Your cart could not be saved on this device. Keep this tab open until you order.");
}

const carts = new Map<string, PersistedStore<Cart>>();

export function cartStore(slug: string): PersistedStore<Cart> {
  let store = carts.get(slug);
  if (!store) {
    store = createPersistedStore({
      key: `krave:menu-cart:${slug}`,
      parse: parseCart,
      serialize: serializeCart,
      onWriteError,
    });
    carts.set(slug, store);
  }
  return store;
}

export const customerDetailsStore = createPersistedStore<CustomerDetails>({
  key: "krave:order-details",
  parse: parseDetails,
  serialize: serializeDetails,
  onWriteError,
});

export const recentOrdersStore = createPersistedStore<RecentOrder[]>({
  key: "krave:recent-menu-orders",
  parse: parseRecentOrders,
  serialize: serializeRecentOrders,
  onWriteError,
});

