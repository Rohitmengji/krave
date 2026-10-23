"use client";

import dynamic from "next/dynamic";

// Dialogs stay out of the storefront's initial chunk: none of them is visible on first paint,
// together they are roughly half of the page's component code, and none runs effects while closed.
const loaders = {
  detail: () => import("./RestaurantDetailModal"),
  cart: () => import("./CartCheckoutDrawer"),
  tracking: () => import("./CrystalLiveTrackingModal"),
  rea: () => import("./ReaInspectorModal"),
  brand: () => import("./BrandThemeModal"),
  account: () => import("./AccountDialog"),
};

export const RestaurantDetailModal = dynamic(() => loaders.detail().then((m) => m.RestaurantDetailModal));
export const CartCheckoutDrawer = dynamic(() => loaders.cart().then((m) => m.CartCheckoutDrawer));
export const CrystalLiveTrackingModal = dynamic(() =>
  loaders.tracking().then((m) => m.CrystalLiveTrackingModal)
);
export const ReaInspectorModal = dynamic(() => loaders.rea().then((m) => m.ReaInspectorModal));
export const BrandThemeModal = dynamic(() => loaders.brand().then((m) => m.BrandThemeModal));
export const AccountDialog = dynamic(() => loaders.account().then((m) => m.AccountDialog));

type IdleHost = {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
  cancelIdleCallback?: (id: number) => void;
  setTimeout: (cb: () => void, ms: number) => unknown;
  clearTimeout: (id: never) => void;
  navigator?: { connection?: { saveData?: boolean } };
};

/**
 * Warms every dialog chunk once the main thread is idle, so the first open is instant without
 * putting the code on the hydration path. Skipped under Save-Data: chunks then load on first open.
 * Returns a cancel function for effect cleanup.
 */
export function scheduleDialogPreload(
  host: IdleHost = globalThis as unknown as IdleHost,
  load: () => void = () => {
    for (const loader of Object.values(loaders)) void loader().catch(() => undefined);
  }
): () => void {
  if (host.navigator?.connection?.saveData) return () => {};
  if (host.requestIdleCallback && host.cancelIdleCallback) {
    const id = host.requestIdleCallback(load, { timeout: 4000 });
    return () => host.cancelIdleCallback!(id);
  }
  const id = host.setTimeout(load, 2000);
  return () => host.clearTimeout(id as never);
}
