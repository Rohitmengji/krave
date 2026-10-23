"use client";

import React, {
  useActionState,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  cancelDemoOrder,
  createNotification,
  DELIVERY_SLOTS,
  DEMO_PAYMENT_METHODS,
  restoreOrderHistory,
  type KraveSessionState,
} from "@/lib/checkout";
import { POS_SEAT_HANDOFF_KEY } from "@/lib/pos/posEngine";
import {
  checkoutFingerprint,
  readCheckoutIntent,
  resolveCheckoutIntent,
  writeCheckoutIntent,
  type CheckoutIntent,
} from "@/lib/checkoutIntent";
import {
  accountReducer,
  INITIAL_ACCOUNT_STATE,
  toggleBookmark,
  upsertOrder,
  upsertReservation,
  type AccountAction,
} from "@/lib/accountState";
import { createLatestSync } from "@/lib/latestSync";
import { filtersReducer, INITIAL_FILTERS, toFilterCriteria, type RestaurantSort } from "@/lib/discoveryFilters";
import type { MemoryStore, PersistedStore } from "@/lib/persistedStore";
import {
  availabilityStore,
  guestBookmarksStore,
  guestNotificationsStore,
  guestOrdersStore,
  guestReservationsStore,
  sessionStore,
  storageWarning,
  updateSession,
} from "@/lib/storefrontStores";
import type { DineInBill } from "@/lib/server/dineInStore";
import type { Dispute } from "@/lib/server/disputeStore";
import {
  Bike,
  UtensilsCrossed,
  Wine,
  Sparkles,
  Filter,
  Leaf,
  Zap,
  Star,
  ArrowUpDown,
  ShoppingBag,
  ArrowRight,
  Cpu,
  Calendar,
  Clock,
  CheckCircle2,
  Store,
  X,
} from "lucide-react";
import {
  BRAND_THEME_PRESETS,
  COLLECTIONS_DATA,
  COUPON_OFFERS,
  RESTAURANTS_DATA,
  SAVED_ADDRESSES,
  TOP_BRANDS_DATA,
} from "@/data/zomatoReconstructedData";
import {
  addOrIncrementCartItem,
  calculateCartQuote,
  CART_LIMITS,
  cartLimitViolation,
  couponIneligibility,
  defaultModifierSelection,
  dishModifierGroups,
  filterAndSortRestaurants,
  findDishAcrossRestaurants,
  modifierSelectionProblem,
  removeOrderedLines,
  updateCartLineQuantity,
} from "@/lib/cartEngine";
import {
  BrandThemePreset,
  CrystalOrderStage,
  CrystalOrderState,
  DiningReservation,
  DishItem,
  ModifierOption,
  RestaurantEntity,
} from "@/types/krave";
import { Navbar } from "./Navbar";
import { RestaurantCardV2 } from "./RestaurantCardV2";
import { RestaurantDetailModal } from "./RestaurantDetailModal";
import { CartCheckoutDrawer } from "./CartCheckoutDrawer";
import { CrystalLiveTrackingModal } from "./CrystalLiveTrackingModal";
import { ReaInspectorModal } from "./ReaInspectorModal";
import { BrandThemeModal } from "./BrandThemeModal";
import { OverlayDialog } from "./OverlayDialog";
import { AccountDialog } from "./AccountDialog";

const CRYSTAL_STAGE_ORDER: CrystalOrderStage[] = [
  "ORDER_CONFIRMED",
  "KITCHEN_PREPARING",
  "RIDER_ASSIGNED",
  "OUT_FOR_DELIVERY",
  "ARRIVED",
];

const NO_BILLS: DineInBill[] = [];
const NO_DISPUTES: Dispute[] = [];

function useStore<T>(store: PersistedStore<T> | MemoryStore<T>): T {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    "getServerSnapshot" in store ? store.getServerSnapshot : store.getSnapshot
  );
}

const subscribeNever = () => () => {};

/** False during the server render and hydration, true once the browser has taken over. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false
  );
}

async function postJson(
  url: string,
  body: unknown,
  fallbackMessage = "The server did not accept that.",
  timeoutMs = 8000
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body),
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = (result as { message?: unknown } | null)?.message;
    throw new Error(typeof message === "string" ? message : fallbackMessage);
  }
  return result;
}

/** GET the account view. Null when offline, timed out, superseded or refused. */
async function requestAccount(controller: AbortController): Promise<unknown> {
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch("/api/webroutes/account/me", { signal: controller.signal });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** The 86 list is outlet-wide, so it applies whoever is signed in. */
function adoptAvailability(payload: unknown) {
  const ids = (payload as { unavailableItemIds?: unknown } | null)?.unavailableItemIds;
  if (Array.isArray(ids)) {
    availabilityStore.set(ids.filter((id): id is string => typeof id === "string"));
  }
}

function adoptServerState(
  dispatch: React.Dispatch<AccountAction>,
  epoch: number,
  payload: unknown
) {
  adoptAvailability(payload);
  dispatch({ type: "SERVER_STATE", epoch, payload });
}

const sendBookmarks = createLatestSync<number[]>(async (bookmarks) => {
  await postJson("/api/webroutes/account/bookmarks", { bookmarks });
});

const sendMembership = createLatestSync<boolean>(async (isGoldMember) => {
  await postJson("/api/webroutes/account/membership", { isGoldMember });
});

interface ClaimFormState {
  error: string | null;
  /** Echoed back so a rejected code stays in the box for correcting after React resets the form. */
  code: string;
}

export function KraveApp({
  initialRestaurantId,
  initialView,
}: {
  initialRestaurantId?: number;
  initialView?: "orders";
} = {}) {
  // Device-owned state lives in browser storage, one store per key, shared live with other
  // tabs. Account-owned state lives in a reducer and is never written to this device.
  const hydrated = useHydrated();
  const session = useStore(sessionStore);
  const guestOrders = useStore(guestOrdersStore);
  const guestReservations = useStore(guestReservationsStore);
  const guestNotifications = useStore(guestNotificationsStore);
  const guestBookmarks = useStore(guestBookmarksStore);
  const unavailableItemIds = useStore(availabilityStore);
  const storageWarningMessage = useStore(storageWarning);

  const [accountState, dispatchAccount] = useReducer(accountReducer, INITIAL_ACCOUNT_STATE);
  const accountData = accountState.data;
  const account = accountData?.user ?? null;
  const orderHistory = accountData ? accountData.orders : guestOrders;
  const reservations = accountData ? accountData.reservations : guestReservations;
  const notifications = accountData ? accountData.notifications : guestNotifications;
  const bookmarkedIds = accountData ? accountData.bookmarks : guestBookmarks;
  const dineInBills = accountData?.dineInBills ?? NO_BILLS;
  const disputes = accountData?.disputes ?? NO_DISPUTES;
  const isGoldMember = account ? account.isGoldMember : session.isGoldMember;
  // Only the newest account read may land: an older one finishing later shows older data.
  const refreshController = useRef<AbortController | null>(null);

  // Brand studio edits are a live preview layered on the saved preset.
  const [themeEdits, setThemeEdits] = useState<{
    themeId: string;
    updates: Partial<BrandThemePreset>;
  } | null>(null);
  const theme = useMemo(() => {
    const preset =
      BRAND_THEME_PRESETS.find((candidate) => candidate.id === session.themeId) ??
      BRAND_THEME_PRESETS[0];
    return themeEdits?.themeId === preset.id
      ? { ...preset, ...themeEdits.updates, id: preset.id }
      : preset;
  }, [session.themeId, themeEdits]);
  const isDark = session.isDark;

  // Discovery filters belong to this tab: browsing in one tab must not rearrange another.
  const [filters, dispatchFilters] = useReducer(filtersReducer, INITIAL_FILTERS);
  const activeMode = filters.mode;

  // The cart is saved with the session, so every tab works on the same cart.
  const currentAddress =
    SAVED_ADDRESSES.find((address) => address.id === session.addressId) ?? SAVED_ADDRESSES[0];
  const cartItems = session.cartItems;
  const appliedCoupon = session.couponCode;
  const riderTip = session.riderTip;
  const scheduledSlot = session.scheduledSlot;
  const handling = session.handling;
  const [cartOpen, setCartOpen] = useState(false);
  const [priceLock, setPriceLock] = useState<{ token: string; expiresAt: number } | null>(null);

  const [inboxOpen, setInboxOpen] = useState(false);
  const [offersOpen, setOffersOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [disputePending, setDisputePending] = useState(false);
  const disputeLock = useRef(false);

  // Modals & Post-Order State
  const [selectedRestaurant, setSelectedRestaurant] = useState<{
    restaurant: RestaurantEntity;
    initialTab: "menu" | "book" | "reviews";
  } | null>(null);
  // An id, not a copy: a stage change or a cancellation (in any tab) shows up here as is.
  const [activeOrderId, setActiveOrderId] = useState<string | null>(null);
  const activeCrystalOrder =
    orderHistory.find((order) => order.orderId === activeOrderId) ?? orderHistory[0] ?? null;
  const [crystalModalOpen, setCrystalModalOpen] = useState(false);
  const [reaInspectorOpen, setReaInspectorOpen] = useState(false);
  const [brandStudioOpen, setBrandStudioOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  // Part of the quote, not just the drawer: some offers are bound to how the customer pays.
  const [paymentMethod, setPaymentMethod] = useState<string>(DEMO_PAYMENT_METHODS[0]);
  const checkoutLock = useRef(false);
  // In-memory copy of the pending checkout intent; sessionStorage covers a reload.
  const checkoutIntent = useRef<CheckoutIntent | null>(null);

  useEffect(() => {
    try {
      const probe = "krave.storage-probe";
      localStorage.setItem(probe, "1");
      localStorage.removeItem(probe);
    } catch {
      storageWarning.set("Browser storage is unavailable. Orders will last only for this visit.");
    }
    // The last mode is where a new visit starts; it is not kept in step across open tabs.
    dispatchFilters({ type: "SET_MODE", mode: sessionStore.getSnapshot().mode });
  }, []);

  // Deep links open the shared surface once the app is interactive.
  useEffect(() => {
    if (!initialRestaurantId) return;
    const restaurant = RESTAURANTS_DATA.find(
      (candidate) => candidate.resId === initialRestaurantId
    );
    if (restaurant) setSelectedRestaurant({ restaurant, initialTab: "menu" });
  }, [initialRestaurantId]);

  useEffect(() => {
    const controller = new AbortController();
    refreshController.current = controller;
    // Offline or no server: the local demo session stays in charge.
    void requestAccount(controller).then((payload) => {
      if (payload && refreshController.current === controller) {
        adoptServerState(dispatchAccount, INITIAL_ACCOUNT_STATE.epoch, payload);
      }
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (initialView !== "orders" || !hydrated) return;
    document.getElementById("order-history-heading")?.scrollIntoView({ block: "start" });
  }, [initialView, hydrated]);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 3200);
  };

  /** Pull the account view again after something changed it on the server. */
  function refreshAccount(): Promise<void> {
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    const epoch = accountState.epoch;
    return requestAccount(controller).then((payload) => {
      if (payload && refreshController.current === controller) {
        adoptServerState(dispatchAccount, epoch, payload);
      }
    });
  }

  /** A reply to a change this account made: newer than any account read still in flight. */
  function receiveServerState(epoch: number, payload: unknown) {
    refreshController.current?.abort();
    adoptServerState(dispatchAccount, epoch, payload);
  }

  const notify = (
    kind: "ORDER" | "RESERVATION" | "SYSTEM",
    title: string,
    body: string
  ) => {
    // Signed in, the server already recorded this; adding it locally would duplicate it.
    if (account) {
      void refreshAccount();
      return;
    }
    guestNotificationsStore.set((previous) =>
      [createNotification(kind, title, body), ...previous].slice(0, 40)
    );
  };

  /** Any change still queued for the previous session must not reach the next one. */
  function endAccountSession() {
    refreshController.current?.abort();
    sendBookmarks.discard();
    sendMembership.discard();
  }

  function handleAuthenticated(payload: unknown) {
    endAccountSession();
    adoptAvailability(payload);
    dispatchAccount({ type: "SIGNED_IN", payload });
    setActiveOrderId(null);
  }

  async function handleSignOut() {
    endAccountSession();
    try {
      await fetch("/api/webroutes/auth/logout", {
        method: "POST",
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      // Clearing local state still signs the browser out of the UI.
    }
    // Bumps the session epoch, so replies still in flight for the account are dropped.
    endAccountSession();
    dispatchAccount({ type: "SIGNED_OUT" });
    setActiveOrderId(null);
    showToast("Signed out. This browser is back in local demo mode.");
  }

  const changeMode = (mode: KraveSessionState["mode"]) => {
    dispatchFilters({ type: "SET_MODE", mode });
    updateSession("mode", mode);
  };

  const filteredRestaurants = useMemo(
    () => filterAndSortRestaurants(RESTAURANTS_DATA, toFilterCriteria(filters)),
    [filters]
  );

  const visibleCollections = useMemo(
    () => COLLECTIONS_DATA.filter((c) => c.modes.includes(activeMode)),
    [activeMode]
  );

  // The applied code stays saved; it is simply not quoted while this customer cannot use it,
  // so switching to a card or turning on membership brings it straight back.
  const couponBlockedReason = couponIneligibility(appliedCoupon, { isGoldMember, paymentMethod });
  const usableCoupon = couponBlockedReason ? null : appliedCoupon;

  const cartQuote = useMemo(
    () =>
      calculateCartQuote(cartItems, {
        couponCode: usableCoupon,
        isGoldMember,
        riderTip,
      }),
    [cartItems, usableCoupon, isGoldMember, riderTip]
  );
  // The lock must be issued for exactly what placement will send, or it can never apply.
  const quotedCoupon = cartQuote.couponCode;

  // The lock is issued by the server against the exact cart, so it is refreshed whenever
  // the cart changes. Stale replies are dropped: a lock for a cart the user has already
  // edited is worthless, and applying one out of order would show a price we cannot honour.
  useEffect(() => {
    if (cartItems.length === 0) {
      setPriceLock(null);
      return;
    }
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch("/api/webroutes/order/cart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            items: cartItems.map((line) => ({
              itemId: line.item.id,
              quantity: line.quantity,
              optionIds: line.selectedOptions.map((option) => option.id),
            })),
            addressId: currentAddress.id,
            paymentMethod,
            couponCode: quotedCoupon,
            isGoldMember,
            riderTip,
          }),
        });
        if (!response.ok) return;
        const result = await response.json();
        if (typeof result?.priceLock === "string") {
          setPriceLock({
            token: result.priceLock,
            expiresAt: Date.now() + Number(result.priceLockMinutes ?? 10) * 60_000,
          });
        }
      } catch {
        // A missing lock is not an error: checkout simply uses the live price.
        if (!controller.signal.aborted) setPriceLock(null);
      }
    })();
    return () => controller.abort();
  }, [cartItems, quotedCoupon, paymentMethod, isGoldMember, riderTip, currentAddress.id]);

  const handleAddToCart = (
    restaurant: RestaurantEntity,
    dish: DishItem,
    quantity: number,
    // Omitted by quick-add, which takes the defaults. An empty array is a real choice.
    selectedOptions?: ModifierOption[],
    cookingInstruction?: string
  ) => {
    if (checkoutLock.current) return;
    if (unavailableItemIds.includes(dish.id)) {
      showToast(`${dish.name} is marked unavailable right now.`);
      return;
    }
    const groups = dishModifierGroups(restaurant, dish);
    const options = selectedOptions ?? defaultModifierSelection(groups);
    const selectionProblem = modifierSelectionProblem(groups, new Set(options.map((option) => option.id)));
    if (selectionProblem) {
      showToast(selectionProblem);
      return;
    }
    if (cartItems.length && cartItems[0].resId !== restaurant.resId &&
        !window.confirm(`Replace your ${cartItems[0].restaurantName} cart with items from ${restaurant.name}?`)) return;
    // Judged against the cart as stored now, which another tab may have changed since render.
    const outcome = { refusal: null as string | null };
    updateSession("cartItems", (prev) => {
      const next = addOrIncrementCartItem(prev, restaurant, dish, quantity, options, cookingInstruction);
      outcome.refusal = cartLimitViolation(next);
      return outcome.refusal ? prev : next;
    });
    showToast(outcome.refusal ?? `Added ${quantity}× ${dish.name} to ${restaurant.name} cart`);
  };

  const handleUpdateCartQuantity = (lineItemId: string, quantity: number) => {
    const bounded = Math.min(quantity, CART_LIMITS.maxLineQuantity);
    updateSession("cartItems", (prev) => updateCartLineQuantity(prev, lineItemId, bounded));
  };

  const handlePlaceOrder = async () => {
    if (checkoutLock.current || !cartItems.length) return;
    const blocked = cartItems.find((line) => unavailableItemIds.includes(line.item.id));
    if (blocked) {
      setCheckoutError(`${blocked.item.name} is marked unavailable. Remove it to continue.`);
      return;
    }
    checkoutLock.current = true;
    setCheckoutPending(true);
    setCheckoutError(null);
    // Who placed it and what was in the cart, as of the click; both can change before the reply.
    const epoch = accountState.epoch;
    const placedByAccount = account !== null;
    const orderedLines = cartItems;
    const request = {
      items: orderedLines.map((line) => ({ itemId: line.item.id, quantity: line.quantity,
        optionIds: line.selectedOptions.map((option) => option.id), cookingInstruction: line.cookingInstruction })),
      addressId: currentAddress.id, paymentMethod, couponCode: cartQuote.couponCode,
      isGoldMember, riderTip, scheduledSlot, handling,
      priceLock: priceLock?.token ?? null,
    };
    // Same order, same key: a retry after a lost response replays the original order.
    const intent = resolveCheckoutIntent(
      checkoutFingerprint(request),
      checkoutIntent.current ?? readCheckoutIntent()
    );
    checkoutIntent.current = intent;
    writeCheckoutIntent(intent);
    try {
      const response = await fetch("/api/webroutes/order/makeOrder", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": intent.key,
        },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify(request),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(typeof result?.message === "string" ? result.message : "Checkout failed. Please try again.");
      const order = restoreOrderHistory(JSON.stringify([result.order]))[0];
      if (!order) throw new Error("Checkout returned an invalid confirmation. Your cart was kept.");
      checkoutIntent.current = null;
      writeCheckoutIntent(null);
      // A replayed confirmation carries the same order id, so history keeps one entry.
      if (placedByAccount) {
        dispatchAccount({ type: "ORDER_PLACED", epoch, order });
      } else {
        guestOrdersStore.set((previous) => upsertOrder(previous, order));
      }
      setActiveOrderId(order.orderId);
      // Only what was ordered leaves the cart; another tab may have added more meanwhile.
      updateSession("cartItems", (current) => removeOrderedLines(current, orderedLines));
      setCartOpen(false);
      setCrystalModalOpen(true);
      notify(
        "ORDER",
        `Demo order confirmed at ${order.restaurantName}`,
        order.scheduledSlot === DELIVERY_SLOTS[0]
          ? `Arriving in about ${order.etaMinutes} minutes. No payment was collected.`
          : `Scheduled for ${order.scheduledSlot}. No payment was collected.`
      );
      showToast("Demo order confirmed. No payment was collected.");
    } catch (error) {
      const timedOut = error instanceof DOMException && error.name === "TimeoutError";
      setCheckoutError(
        timedOut
          ? placedByAccount
            ? "We couldn't confirm your order in time. Placing it again is safe; it won't be duplicated."
            : "We couldn't confirm your order in time. It may still have gone through, so wait a moment before ordering again."
          : error instanceof Error ? error.message : "Checkout unavailable. Please try again."
      );
    } finally {
      checkoutLock.current = false;
      setCheckoutPending(false);
    }
  };

  const handleAdvanceCrystalStage = () => {
    const current = activeCrystalOrder;
    if (!current) return;
    const target = CRYSTAL_STAGE_ORDER.indexOf(current.stage) + 1;
    if (target >= CRYSTAL_STAGE_ORDER.length) return;
    const stage = CRYSTAL_STAGE_ORDER[target];
    const body = `${current.restaurantName} · simulated tracking update.`;

    if (!account) {
      // Forward only: another tab may already have moved this order on.
      guestOrdersStore.set((previous) =>
        previous.map((order) =>
          order.orderId === current.orderId &&
          CRYSTAL_STAGE_ORDER.indexOf(order.stage) < target
            ? { ...order, stage }
            : order
        )
      );
      notify("ORDER", stage.replaceAll("_", " "), body);
      return;
    }

    const epoch = accountState.epoch;
    dispatchAccount({ type: "ORDER_STAGE", epoch, orderId: current.orderId, stage });
    // Read the account back only after the write lands, or the read can undo it on screen.
    postJson("/api/webroutes/order/stage", { orderId: current.orderId, stage })
      .then((result) => receiveServerState(epoch, result))
      .catch(() => showToast("Could not save that tracking update to your account."))
      .finally(() => void refreshAccount());
  };

  const handleCancelOrder = async (orderId: string) => {
    if (!window.confirm("Cancel this demo order? It will be removed from your history.")) return;
    const cancelled = orderHistory.find((order) => order.orderId === orderId);
    const epoch = accountState.epoch;
    try {
      if (account) {
        receiveServerState(
          epoch,
          await postJson("/api/webroutes/order/cancel", { orderId }, "Could not cancel that order.")
        );
      } else {
        // Checked against the stored copy, so a stage another tab advanced is respected.
        guestOrdersStore.set((previous) => cancelDemoOrder(previous, orderId));
      }
      if (activeCrystalOrder?.orderId === orderId) {
        setCrystalModalOpen(false);
        setActiveOrderId(null);
      }
      notify(
        "ORDER",
        "Demo order cancelled",
        `${cancelled?.restaurantName ?? "Your order"} was withdrawn before the kitchen started it.`
      );
      showToast("Demo order cancelled.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "This order cannot be cancelled.");
    }
  };

  /** Attach a table bill to this account using the code printed on its receipt. */
  const [claimState, claimAction, claimPending] = useActionState(
    async (_previous: ClaimFormState, formData: FormData): Promise<ClaimFormState> => {
      const code = String(formData.get("code") ?? "").trim().toUpperCase();
      if (!code) return { error: "Enter the code printed on your receipt.", code };
      const epoch = accountState.epoch;
      try {
        const result = await postJson(
          "/api/webroutes/account/claim-bill",
          { code },
          "That code is not valid or has already been used."
        );
        receiveServerState(epoch, result);
        const outletName = (result as { bill?: { outletName?: unknown } } | null)?.bill?.outletName;
        showToast(
          `Table bill from ${typeof outletName === "string" ? outletName : "the restaurant"} added to your history.`
        );
        return { error: null, code: "" };
      } catch (error) {
        return {
          error:
            error instanceof Error ? error.message : "That code is not valid or has already been used.",
          code,
        };
      }
    },
    { error: null, code: "" }
  );

  /** Raise a claim about a delivered order. The outcome is decided server-side. */
  const handleReportIssue = async (order: CrystalOrderState) => {
    if (disputeLock.current) return;
    const first = order.items[0];
    if (!first) return;
    if (
      !window.confirm(
        `Report "${first.item.name}" as missing from this order? The refund is worked out from what you paid.`
      )
    ) {
      return;
    }

    disputeLock.current = true;
    setDisputePending(true);
    const epoch = accountState.epoch;
    try {
      const result = await postJson(
        "/api/webroutes/account/dispute",
        {
          orderId: order.orderId,
          reason: "MISSING_ITEM",
          lines: [{ itemId: first.item.id, quantity: 1 }],
        },
        "Could not raise that claim.",
        10000
      );
      receiveServerState(epoch, result);
      const explanation = (result as { dispute?: { explanation?: unknown } } | null)?.dispute
        ?.explanation;
      showToast(typeof explanation === "string" ? explanation : "Your claim was recorded.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not raise that claim.");
    } finally {
      disputeLock.current = false;
      setDisputePending(false);
    }
  };

  const handleToggleGold = () => {
    const next = !isGoldMember;
    if (!account) {
      updateSession("isGoldMember", next);
      return;
    }
    dispatchAccount({ type: "GOLD_SET", epoch: accountState.epoch, isGoldMember: next });
    sendMembership.push(next).catch(() => {
      showToast("Could not save your membership change.");
      void refreshAccount();
    });
  };

  const handleToggleBookmark = (resId: number) => {
    const saved = !bookmarkedIds.includes(resId);
    if (!account) {
      guestBookmarksStore.set((previous) => toggleBookmark(previous, resId, saved));
      return;
    }
    dispatchAccount({ type: "BOOKMARK_SET", epoch: accountState.epoch, resId, saved });
    sendBookmarks.push(toggleBookmark(bookmarkedIds, resId, saved)).catch(() => {
      showToast("Could not save that bookmark to your account.");
      void refreshAccount();
    });
  };

  const handleToggleAvailability = async (itemId: string, dishName: string) => {
    if (!account) {
      showToast("Sign in as staff to change what the kitchen is serving.");
      return;
    }
    const unavailable = !unavailableItemIds.includes(itemId);
    try {
      adoptAvailability(
        await postJson(
          "/api/webroutes/menu/availability",
          { itemId, unavailable },
          "Could not update availability."
        )
      );
      showToast(
        unavailable
          ? `${dishName} is off the menu for every customer of this outlet.`
          : `${dishName} is back on the menu.`
      );
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Could not update availability.");
    }
  };

  /** Hand a confirmed booking to the dine-in terminal so the host can open its table. */
  const handleSeatBooking = (booking: DiningReservation) => {
    try {
      localStorage.setItem(
        POS_SEAT_HANDOFF_KEY,
        JSON.stringify({
          resId: booking.resId,
          bookingId: booking.bookingId,
          guestName: booking.guestName,
          guests: booking.guests,
          timeSlot: booking.timeSlot,
        })
      );
      window.location.assign("/pos");
    } catch {
      showToast("Browser storage is unavailable, so this booking cannot be sent to the terminal.");
    }
  };

  // Implement Zomato's discovered window.zomato_webmcp agent tool dispatcher
  const invokeWebMcpTool = (toolName: string): Record<string, unknown> => {
    switch (toolName) {
      case "zomato_search_restaurants":
        return {
          ok: true,
          tool: "zomato_search_restaurants",
          context: activeMode,
          count: filteredRestaurants.length,
          results: filteredRestaurants.map((r) => ({
            resId: r.resId,
            name: r.name,
            rating: r.ratings.DELIVERY.rating,
            deliveryTime: r.deliveryTimeText,
            walkinOffer: r.walkinOffer.title,
          })),
        };
      case "zomato_get_restaurant_menu": {
        const res = RESTAURANTS_DATA[0];
        return {
          ok: true,
          tool: "zomato_get_restaurant_menu",
          restaurantId: res.resId,
          restaurantName: res.name,
          menus: res.menus.map((m) => ({
            id: m.id,
            name: m.name,
            items: m.categories.flatMap((c) =>
              c.items.map((i) => ({ id: i.id, name: i.name, price: i.price }))
            ),
          })),
        };
      }
      case "zomato_get_dish_options": {
        const found = findDishAcrossRestaurants("ctl_820099425");
        return {
          ok: true,
          tool: "zomato_get_dish_options",
          itemId: "ctl_820099425",
          dishName: found?.dish.name,
          modifierGroups: found?.dish.modifier_group_ids.map(
            (id) => found.restaurant.modifierGroups[id]
          ),
        };
      }
      case "zomato_add_item_to_cart": {
        const found = findDishAcrossRestaurants("ctl_dal_bukhara");
        if (found) {
          handleAddToCart(found.restaurant, found.dish, 1);
        }
        return {
          ok: true,
          tool: "zomato_add_item_to_cart",
          addedItem: found?.dish.name,
          restaurant: found?.restaurant.name,
          unitPrice: found?.dish.price,
        };
      }
      case "zomato_quote_cart":
        return {
          ok: true,
          tool: "zomato_quote_cart",
          quote: cartQuote,
        };
      case "zomato_list_addresses":
        return {
          ok: true,
          tool: "zomato_list_addresses",
          currentAddressId: currentAddress.id,
          addresses: SAVED_ADDRESSES,
        };
      default:
        return { ok: true, tool: toolName };
    }
  };

  useEffect(() => {
    if (typeof window !== "undefined") {
      const w = window as unknown as Record<string, unknown>;
      w.zomato_webmcp = {
        version: "rea-reconstructed-v1",
        invoke: invokeWebMcpTool,
      };
      w.krave_webmcp = w.zomato_webmcp;
    }
  });

  const selectedCollectionObj = useMemo(
    () =>
      COLLECTIONS_DATA.find((c) => c.id === filters.collectionId) || null,
    [filters.collectionId]
  );

  const unreadNotificationCount = useMemo(
    () => notifications.filter((entry) => !entry.read).length,
    [notifications]
  );

  return (
    <div
      className={`min-h-screen transition-colors duration-300 ${
        isDark ? "bg-[#0A0D12] text-white" : "bg-slate-50 text-slate-900"
      }`}
    >
      {/* Top Navbar */}
      <Navbar
        theme={theme}
        isDark={isDark}
        onToggleDark={() => updateSession("isDark", (dark) => !dark)}
        currentAddress={currentAddress}
        addresses={SAVED_ADDRESSES}
        onSelectAddress={(addr) => {
          updateSession("addressId", addr.id);
          showToast(`Switched Delivery Subzone to ${addr.displayTitle}`);
        }}
        searchQuery={filters.query}
        onSearchChange={(query) => dispatchFilters({ type: "SET_QUERY", query })}
        restaurants={RESTAURANTS_DATA}
        onSelectRestaurant={(res, tab = "menu") =>
          setSelectedRestaurant({ restaurant: res, initialTab: tab })
        }
        onQuickAddDish={(res, dish) => handleAddToCart(res, dish, 1)}
        isGoldMember={isGoldMember}
        onToggleGold={handleToggleGold}
        cartCount={cartQuote.itemCount}
        cartTotal={cartQuote.grandTotal}
        onOpenCart={() => setCartOpen(true)}
        onOpenBrandStudio={() => setBrandStudioOpen(true)}
        hasActiveOrder={Boolean(activeCrystalOrder)}
        onOpenActiveOrder={() => setCrystalModalOpen(true)}
        onOpenOffers={() => setOffersOpen(true)}
        onOpenInbox={() => {
          setInboxOpen(true);
          if (unreadNotificationCount === 0) return;
          if (!account) {
            guestNotificationsStore.set((previous) =>
              previous.map((entry) => (entry.read ? entry : { ...entry, read: true }))
            );
            return;
          }
          dispatchAccount({ type: "NOTIFICATIONS_READ", epoch: accountState.epoch });
          postJson("/api/webroutes/account/notifications/read", {}).catch(() => undefined);
        }}
        unreadCount={unreadNotificationCount}
        accountName={account?.displayName ?? null}
        onOpenAccount={() => setAccountOpen(true)}
      />

      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-24 right-6 z-50 px-4 py-3 rounded-2xl bg-emerald-600 text-white text-xs font-extrabold shadow-2xl flex items-center gap-2 border border-white/20">
          <CheckCircle2 className="w-4 h-4" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Main Content Container */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 space-y-10 pb-28">
        {/* Hero Brand Banner */}
        <section
          className={`relative rounded-3xl border p-6 sm:p-8 overflow-hidden ${
            isDark
              ? "bg-gradient-to-br from-[#121721] via-[#151D2A] to-[#0D131D] border-white/10"
              : "bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 border-slate-300 text-white"
          }`}
        >
          <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
            <div className="space-y-3 max-w-2xl">
              <div className="inline-flex flex-wrap items-center gap-2">
                <span
                  className="px-3 py-1 rounded-full text-[11px] font-black uppercase tracking-wider text-white"
                  style={{ backgroundColor: theme.primaryHex }}
                >
                  {theme.brandName} • {currentAddress.cityName}
                </span>
                <span className="px-3 py-1 rounded-full text-[11px] font-semibold bg-white/10 text-emerald-300 border border-white/15">
                  Express Delivery & Curated Dining
                </span>
              </div>

              <h1 className="text-3xl sm:text-4xl font-black leading-tight">
                {theme.tagline}
              </h1>

              <p className="text-xs sm:text-sm text-white/75 leading-relaxed">
                Order from iconic neighbourhood kitchens, reserve courtyard tables with instant walk-in savings, and unlock complimentary delivery with{" "}
                <strong className="text-amber-300">{theme.membershipName}</strong>.
              </p>
            </div>

            {/* Customer Value Highlights */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 shrink-0">
              <button
                type="button"
                onClick={() => {
                  dispatchFilters({ type: "SHOW_FAST_DELIVERY" });
                  updateSession("mode", "delivery");
                }}
                className="p-3.5 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-left transition"
              >
                <Clock className="w-4 h-4 text-emerald-400 mb-1" />
                <div className="text-lg font-black">22–35 Min</div>
                <div className="text-[11px] text-white/65">Express Delivery</div>
              </button>

              <button
                type="button"
                onClick={() => changeMode("dineout")}
                className="p-3.5 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-left transition"
              >
                <Calendar className="w-4 h-4 text-amber-400 mb-1" />
                <div className="text-lg font-black">Up to 30% Off</div>
                <div className="text-[11px] text-white/65">Table Reservations</div>
              </button>

              <button
                type="button"
                onClick={() => setBrandStudioOpen(true)}
                className="col-span-2 sm:col-span-1 p-3.5 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-left transition"
              >
                <Sparkles className="w-4 h-4 text-indigo-400 mb-1" />
                <div className="text-lg font-black">4 Themes</div>
                <div className="text-[11px] text-white/65">Live Brand Studio</div>
              </button>
            </div>
          </div>
        </section>

        {/* Mode Tabs: Delivery | Dining Out | Nightlife */}
        <section className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-current/10 pb-4">
          <div className="flex items-center gap-3 overflow-x-auto">
            {(
              [
                {
                  key: "delivery",
                  title: "Delivery",
                  subtitle: "22–38 min Express",
                  icon: Bike,
                },
                {
                  key: "dineout",
                  title: "Dining Out",
                  subtitle: "Book Table + Flat 25% Off",
                  icon: UtensilsCrossed,
                },
                {
                  key: "nightlife",
                  title: "Nightlife",
                  subtitle: "Rooftops & Craft Bars",
                  icon: Wine,
                },
              ] as const
            ).map((tab) => {
              const Icon = tab.icon;
              const isSelected = activeMode === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => changeMode(tab.key)}
                  data-testid={`mode-tab-${tab.key}`}
                  className={`flex items-center gap-3 px-5 py-3 rounded-2xl border transition shrink-0 ${
                    isSelected
                      ? "text-white shadow-lg border-transparent"
                      : isDark
                      ? "bg-[#121721] border-white/10 hover:border-white/25"
                      : "bg-white border-slate-200 hover:border-slate-300"
                  }`}
                  style={
                    isSelected ? { backgroundColor: theme.primaryHex } : undefined
                  }
                >
                  <div
                    className={`w-10 h-10 rounded-xl flex items-center justify-center ${
                      isSelected ? "bg-black/25 text-white" : "bg-current/10"
                    }`}
                  >
                    <Icon className="w-5 h-5" />
                  </div>
                  <div className="text-left">
                    <div className="font-black text-sm">{tab.title}</div>
                    <div
                      className={`text-[11px] ${
                        isSelected ? "text-white/85" : "opacity-60"
                      }`}
                    >
                      {tab.subtitle}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="text-xs opacity-70 hidden xl:block font-medium">
            {filteredRestaurants.length} curated places in {currentAddress.displayTitle}
          </div>
        </section>

        {/* Curated Collections Carousel */}
        <section className="space-y-4">
          <div className="flex items-end justify-between gap-2">
            <div>
              <h2 className="text-xl sm:text-2xl font-black tracking-tight">
                Curated Collections in {currentAddress.cityName}
              </h2>
              <p className="text-xs opacity-65 mt-0.5">
                Explore handpicked lists of top restaurants, courtyards, and bars based on trends
              </p>
            </div>
            {selectedCollectionObj && (
              <button
                type="button"
                onClick={() => dispatchFilters({ type: "CLEAR_COLLECTION" })}
                className="text-xs font-bold px-3 py-1.5 rounded-xl bg-rose-500/20 text-rose-400 flex items-center gap-1"
              >
                <X className="w-3.5 h-3.5" />
                Clear Collection: {selectedCollectionObj.name}
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {visibleCollections.map((col) => {
              const active = filters.collectionId === col.id;
              return (
                <button
                  key={col.id}
                  type="button"
                  onClick={() =>
                    dispatchFilters({ type: "TOGGLE_COLLECTION", collectionId: col.id })
                  }
                  data-testid={`collection-card-${col.id}`}
                  className={`group relative h-52 rounded-3xl overflow-hidden text-left border transition-all ${
                    active
                      ? "ring-4 ring-emerald-400 border-emerald-400"
                      : "border-white/10 hover:-translate-y-1"
                  }`}
                >
                  <img
                    src={col.image}
                    alt={col.name}
                    className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105"
                  />
                  <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/35 to-transparent" />
                  <span
                    className="absolute top-3 left-3 px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider text-white"
                    style={{ backgroundColor: theme.primaryHex }}
                  >
                    {col.tag}
                  </span>
                  <div className="absolute bottom-3.5 left-4 right-4 text-white">
                    <div className="font-black text-base leading-snug">
                      {col.name}
                    </div>
                    <div className="text-[11px] text-white/75 line-clamp-1 mt-0.5">
                      {col.subtitle}
                    </div>
                    <div className="text-xs font-bold text-emerald-300 mt-1">
                      {col.placesCount} →
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* Top Brands Rail (For Delivery Mode) */}
        {activeMode === "delivery" && (
          <section className="space-y-4">
            <div>
              <h2 className="text-lg sm:text-xl font-black tracking-tight">
                Top Brands for You
              </h2>
              <p className="text-xs opacity-65">
                Order from your most-loved neighbourhood kitchens and iconic dining brands
              </p>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
              {TOP_BRANDS_DATA.map((brand) => {
                const targetRes = RESTAURANTS_DATA.find(
                  (r) => r.resId === brand.resId
                );
                return (
                  <button
                    key={brand.id}
                    type="button"
                    onClick={() => {
                      if (targetRes) {
                        setSelectedRestaurant({
                          restaurant: targetRes,
                          initialTab: "menu",
                        });
                      }
                    }}
                    className={`p-3.5 rounded-2xl border text-center transition hover:-translate-y-0.5 ${
                      isDark
                        ? "bg-[#121721] border-white/10 hover:border-white/25"
                        : "bg-white border-slate-200 hover:border-slate-300 shadow-sm"
                    }`}
                  >
                    <img
                      src={brand.image}
                      alt={brand.name}
                      className="w-16 h-16 rounded-full object-cover mx-auto border-2"
                      style={{ borderColor: brand.accentColor }}
                    />
                    <div className="font-extrabold text-xs mt-2.5 truncate">
                      {brand.name}
                    </div>
                    <div className="text-[11px] opacity-60 mt-0.5">
                      {brand.deliveryTime}
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}

        {/* Smart Filter Pills & Sort Controls */}
        <section className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold opacity-60 flex items-center gap-1 mr-1">
              <Filter className="w-3.5 h-3.5" /> Filters:
            </span>

            <button
              type="button"
              onClick={() => dispatchFilters({ type: "TOGGLE", filter: "minRating43" })}
              data-testid="filter-rating-43"
              className={`px-3.5 py-2 rounded-xl text-xs font-bold border transition flex items-center gap-1.5 ${
                filters.minRating43
                  ? "border-emerald-400 bg-emerald-500/20 text-emerald-300"
                  : isDark
                  ? "bg-[#121721] border-white/10"
                  : "bg-white border-slate-200"
              }`}
            >
              <Star className="w-3.5 h-3.5 text-amber-400 fill-current" />
              Rating 4.3+
            </button>

            <button
              type="button"
              onClick={() => dispatchFilters({ type: "TOGGLE", filter: "pureVegOnly" })}
              data-testid="filter-pure-veg"
              className={`px-3.5 py-2 rounded-xl text-xs font-bold border transition flex items-center gap-1.5 ${
                filters.pureVegOnly
                  ? "border-emerald-400 bg-emerald-500/20 text-emerald-300"
                  : isDark
                  ? "bg-[#121721] border-white/10"
                  : "bg-white border-slate-200"
              }`}
            >
              <Leaf className="w-3.5 h-3.5 text-emerald-400" />
              Pure Veg
            </button>

            <button
              type="button"
              onClick={() => dispatchFilters({ type: "TOGGLE", filter: "fastDeliveryOnly" })}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold border transition flex items-center gap-1.5 ${
                filters.fastDeliveryOnly
                  ? "border-emerald-400 bg-emerald-500/20 text-emerald-300"
                  : isDark
                  ? "bg-[#121721] border-white/10"
                  : "bg-white border-slate-200"
              }`}
            >
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              Under 28 Mins
            </button>

            <button
              type="button"
              onClick={() => dispatchFilters({ type: "TOGGLE", filter: "walkinOfferOnly" })}
              className={`px-3.5 py-2 rounded-xl text-xs font-bold border transition flex items-center gap-1.5 ${
                filters.walkinOfferOnly
                  ? "border-emerald-400 bg-emerald-500/20 text-emerald-300"
                  : isDark
                  ? "bg-[#121721] border-white/10"
                  : "bg-white border-slate-200"
              }`}
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              Flat 15%+ Walk-in Off
            </button>

            {["North Indian", "Japanese", "Biryani", "Cafe"].map((cuisine) => {
              const active = filters.cuisine === cuisine;
              return (
                <button
                  key={cuisine}
                  type="button"
                  onClick={() => dispatchFilters({ type: "TOGGLE_CUISINE", cuisine })}
                  className={`px-3 py-2 rounded-xl text-xs font-bold border transition ${
                    active
                      ? "border-indigo-400 bg-indigo-500/20 text-indigo-300"
                      : isDark
                      ? "bg-[#121721] border-white/10"
                      : "bg-white border-slate-200"
                  }`}
                >
                  {cuisine}
                </button>
              );
            })}
          </div>

          {/* Sort Dropdown */}
          <div className="flex items-center gap-2">
            <ArrowUpDown className="w-3.5 h-3.5 opacity-60" />
            <select
              value={filters.sortBy}
              onChange={(e) =>
                dispatchFilters({ type: "SET_SORT", sortBy: e.target.value as RestaurantSort })
              }
              aria-label="Sort restaurants"
              className={`px-3 py-2 rounded-xl border text-xs font-bold ${
                isDark
                  ? "bg-[#121721] border-white/10 text-white"
                  : "bg-white border-slate-200 text-slate-900"
              }`}
            >
              <option value="relevance">Sort: Relevance (Promoted)</option>
              <option value="rating_desc">Sort: Rating (High to Low)</option>
              <option value="delivery_time">Sort: Fastest Delivery</option>
              <option value="cost_asc">Sort: Cost (Low to High)</option>
              <option value="cost_desc">Sort: Cost (High to Low)</option>
            </select>
          </div>
        </section>

        {/* RestaurantCardV2 Grid */}
        <section className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-xl sm:text-2xl font-black tracking-tight">
              {activeMode === "delivery"
                ? `Best Food Delivery in ${currentAddress.displayTitle}`
                : activeMode === "dineout"
                ? `Trending Dining Out Places in ${currentAddress.cityName}`
                : `Midnight Lounges & Bars in ${currentAddress.cityName}`}
            </h2>
            <span className="text-xs opacity-60 font-semibold">
              Showing {filteredRestaurants.length} places
            </span>
          </div>

          {filteredRestaurants.length === 0 ? (
            <div
              className={`p-12 rounded-3xl border text-center space-y-3 ${
                isDark ? "bg-[#121721] border-white/10" : "bg-white border-slate-200"
              }`}
            >
              <p className="font-bold text-base">
                No restaurants match your current filters
              </p>
              <button
                type="button"
                onClick={() => dispatchFilters({ type: "RESET" })}
                className="px-4 py-2 rounded-xl text-xs font-black text-white"
                style={{ backgroundColor: theme.primaryHex }}
              >
                Reset All Filters
              </button>
            </div>
          ) : (
            <div
              data-testid="restaurant-grid"
              className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
            >
              {filteredRestaurants.map((restaurant) => (
                <RestaurantCardV2
                  key={restaurant.resId}
                  restaurant={restaurant}
                  activeMode={activeMode}
                  theme={theme}
                  isDark={isDark}
                  isGoldMember={isGoldMember}
                  isBookmarked={bookmarkedIds.includes(restaurant.resId)}
                  onToggleBookmark={handleToggleBookmark}
                  onOpenRestaurant={(res, tab = "menu") =>
                    setSelectedRestaurant({ restaurant: res, initialTab: tab })
                  }
                />
              ))}
            </div>
          )}
        </section>

        {/* Recent Orders & Table Reservations Section */}
        <section
          aria-labelledby="order-history-heading"
          className={`p-6 rounded-3xl border space-y-5 ${
            isDark
              ? "bg-[#121721] border-white/10"
              : "bg-white border-slate-200 shadow-sm"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h2 id="order-history-heading" className="text-xl font-black">
                Your Recent Orders & Table Bookings
              </h2>
              <p className="text-xs opacity-65">
                Track active deliveries, reorder favourite meals, or review upcoming reservations
              </p>
              <a
                href="/orders"
                data-testid="orders-permalink"
                className="text-[11px] font-bold text-emerald-400 hover:underline"
              >
                Open this page on its own →
              </a>
            </div>
            {storageWarningMessage && (
              <p role="status" className="text-xs text-amber-400">
                {storageWarningMessage}
              </p>
            )}
          </div>

          {!orderHistory.length && !reservations.length ? (
            <p className="text-xs opacity-65">
              No recent orders or table reservations yet. Choose a restaurant above to order or book a table.
            </p>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <div className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider opacity-60">
                  Delivery Orders ({orderHistory.length})
                </h3>
                {!orderHistory.length ? (
                  <p className="text-xs opacity-60">No delivery orders yet.</p>
                ) : (
                  <ul className="divide-y divide-current/10">
                    {orderHistory.map((order) => (
                      <li
                        key={order.orderId}
                        className="py-3 flex flex-wrap items-center justify-between gap-3"
                        data-testid="order-history-entry"
                      >
                        <div className="min-w-0">
                          <h4 className="font-bold text-sm">{order.restaurantName}</h4>
                          <p className="text-xs opacity-70">
                            {new Date(order.placedAt).toLocaleString()} ·{" "}
                            {order.items.reduce((sum, line) => sum + line.quantity, 0)} items · ₹
                            {order.quote.grandTotal}
                          </p>
                          <p className="text-xs text-emerald-400 font-semibold mt-0.5">
                            {order.stage.replaceAll("_", " ")}
                          </p>
                          {(() => {
                            const dispute = disputes.find(
                              (candidate) => candidate.orderId === order.orderId
                            );
                            if (!dispute) return null;
                            return (
                              <p
                                data-testid={`dispute-status-${order.orderId}`}
                                className="text-xs mt-0.5 text-amber-300"
                              >
                                {dispute.status === "AUTO_REFUNDED"
                                  ? `Refunded ₹${dispute.refundAmount} — ${dispute.explanation}`
                                  : dispute.explanation}
                              </p>
                            );
                          })()}
                        </div>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="px-3 py-1.5 border border-current/15 rounded-xl text-xs font-bold hover:bg-white/5"
                            onClick={() => {
                              setActiveOrderId(order.orderId);
                              setCrystalModalOpen(true);
                            }}
                          >
                            <Bike className="w-3.5 h-3.5 inline mr-1" />
                            Track
                          </button>
                          {order.stage === "ARRIVED" &&
                            !disputes.some(
                              (candidate) => candidate.orderId === order.orderId
                            ) && (
                              <button
                                type="button"
                                data-testid={`report-issue-${order.orderId}`}
                                disabled={disputePending}
                                className="px-3 py-1.5 border border-current/15 rounded-xl text-xs font-bold hover:bg-white/5 disabled:opacity-50"
                                onClick={() => handleReportIssue(order)}
                              >
                                Report an issue
                              </button>
                            )}
                          <button
                            type="button"
                            disabled={checkoutPending}
                            className="px-3 py-1.5 border border-current/15 rounded-xl text-xs font-bold hover:bg-white/5 disabled:opacity-50"
                            onClick={() => {
                              if (
                                cartItems.length &&
                                !window.confirm("Replace your current cart with this order?")
                              )
                                return;
                              updateSession("cartItems", order.items);
                              setCartOpen(true);
                            }}
                          >
                            <ShoppingBag className="w-3.5 h-3.5 inline mr-1" />
                            Reorder
                          </button>
                          {order.stage === "ORDER_CONFIRMED" && (
                            <button
                              type="button"
                              data-testid="cancel-order"
                              className="px-3 py-1.5 border border-current/15 rounded-xl text-xs font-bold text-rose-400 hover:bg-rose-500/10"
                              onClick={() => handleCancelOrder(order.orderId)}
                            >
                              <X className="w-3.5 h-3.5 inline mr-1" />
                              Cancel
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="space-y-2">
                <h3 className="text-xs font-bold uppercase tracking-wider opacity-60">
                  Table Reservations ({reservations.length})
                </h3>
                {!reservations.length ? (
                  <p className="text-xs opacity-60">No table reservations yet.</p>
                ) : (
                  <ul className="divide-y divide-current/10">
                    {reservations.map((booking) => (
                      <li
                        key={booking.bookingId}
                        data-testid="reservation-history-entry"
                        className="py-3 flex flex-wrap items-center justify-between gap-3"
                      >
                        <div>
                          <h4 className="font-bold text-sm">{booking.restaurantName}</h4>
                          <p className="text-xs opacity-70">
                            {booking.date} at {booking.timeSlot} · {booking.guests}{" "}
                            {booking.guests === 1 ? "Guest" : "Guests"}
                          </p>
                          <p className="text-xs text-emerald-400 font-semibold mt-0.5">
                            {booking.offerApplied}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            data-testid="seat-booking"
                            onClick={() => handleSeatBooking(booking)}
                            className="px-3 py-1.5 border border-current/15 rounded-xl text-xs font-bold hover:bg-white/5"
                          >
                            <Store className="w-3.5 h-3.5 inline mr-1" />
                            Seat at Terminal
                          </button>
                          <span className="px-2.5 py-1 rounded-lg text-[10px] font-black bg-emerald-500/15 text-emerald-400">
                            {booking.bookingId}
                          </span>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {/* Dine-in bills claimed from a printed receipt */}
          {account && (
            <div className="space-y-2 border-t border-current/10 pt-5">
              <h3 className="text-xs font-bold uppercase tracking-wider opacity-60">
                Table Bills ({dineInBills.length})
              </h3>
              <p className="text-xs opacity-65">
                Ate in? Enter the code on your receipt to keep that bill with your delivery
                history. The restaurant never sees your account.
              </p>

              <form action={claimAction} className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  name="code"
                  // React clears the form after each submit; a rejected code comes back here.
                  defaultValue={claimState.code}
                  data-testid="claim-bill-code"
                  placeholder="Receipt code"
                  aria-label="Receipt code"
                  autoComplete="off"
                  autoCapitalize="characters"
                  spellCheck={false}
                  aria-invalid={claimState.error ? true : undefined}
                  className={`px-3 py-2 rounded-xl border text-xs font-bold tracking-widest uppercase ${
                    isDark ? "bg-[#0E131D] border-white/15" : "bg-white border-slate-200"
                  }`}
                />
                <button
                  type="submit"
                  data-testid="claim-bill-submit"
                  disabled={claimPending}
                  className="px-4 py-2 rounded-xl text-xs font-black text-white disabled:opacity-60"
                  style={{ backgroundColor: theme.primaryHex }}
                >
                  {claimPending ? "Adding…" : "Add Table Bill"}
                </button>
              </form>

              {claimState.error && (
                <p role="alert" className="text-xs text-rose-400">
                  {claimState.error}
                </p>
              )}

              {dineInBills.length > 0 && (
                <ul className="divide-y divide-current/10">
                  {dineInBills.map((bill) => (
                    <li
                      key={bill.sessionId}
                      data-testid="dine-in-bill-entry"
                      className="py-3 flex flex-wrap items-center justify-between gap-3"
                    >
                      <div>
                        <h4 className="font-bold text-sm">{bill.outletName}</h4>
                        <p className="text-xs opacity-70">
                          {new Date(bill.settledAt).toLocaleString()} · Table {bill.tableId} ·{" "}
                          {bill.guestCount} {bill.guestCount === 1 ? "Guest" : "Guests"}
                        </p>
                        <p className="text-xs opacity-70">
                          {bill.lines.map((line) => `${line.quantity}× ${line.name}`).join(", ")}
                        </p>
                      </div>
                      <span className="text-sm font-black" style={{ color: theme.primaryHex }}>
                        ₹{bill.grandTotal}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </section>
      </main>

      {/* Floating Bottom Cart Bar */}
      {cartItems.length > 0 && !cartOpen && (
        <div className="fixed bottom-5 left-4 right-4 z-30 max-w-3xl mx-auto">
          <div
            onClick={() => setCartOpen(true)}
            data-testid="floating-cart-bar"
            className="p-4 rounded-2xl text-white shadow-2xl flex items-center justify-between cursor-pointer border border-white/25 transition hover:scale-[1.01]"
            style={{ backgroundColor: theme.primaryHex }}
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-black/25 flex items-center justify-center">
                <ShoppingBag className="w-5 h-5" />
              </div>
              <div>
                <div className="text-xs font-black uppercase tracking-wider">
                  {cartQuote.itemCount}{" "}
                  {cartQuote.itemCount === 1 ? "Item" : "Items"} • ₹
                  {cartQuote.grandTotal}
                </div>
                <div className="text-[11px] opacity-90">
                  From {cartItems[0].restaurantName} • Saving ₹
                  {cartQuote.totalSavings}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2 font-black text-xs bg-black/25 px-4 py-2.5 rounded-xl">
              <span>View Cart & Checkout</span>
              <ArrowRight className="w-4 h-4" />
            </div>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer
        className={`border-t py-12 px-4 sm:px-6 lg:px-8 text-xs ${
          isDark
            ? "bg-[#07090D] border-white/10 text-white/65"
            : "bg-slate-900 border-slate-800 text-slate-400"
        }`}
      >
        <div className="max-w-7xl mx-auto space-y-6">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span
                className="w-8 h-8 rounded-xl flex items-center justify-center font-black text-white"
                style={{ backgroundColor: theme.primaryHex }}
              >
                {theme.brandName.slice(0, 1)}
              </span>
              <span className="font-black text-lg text-white">
                {theme.brandName}
              </span>
              <span className="text-xs opacity-70">
                {theme.tagline}
              </span>
            </div>

            <div className="flex flex-wrap gap-2 text-[11px]">
              <span className="px-2.5 py-1 rounded-lg bg-white/5 border border-white/10">
                Delhi NCR • Bengaluru • Gurgaon
              </span>
              <span className="px-2.5 py-1 rounded-lg bg-white/5 border border-white/10">
                {theme.membershipName} Dining & Delivery
              </span>
            </div>
          </div>

          <div className="border-t border-white/10 pt-6 flex flex-col sm:flex-row justify-between gap-4 text-[11px]">
            <p>
              Independent food-ordering demo informed by public web observations. Payments and tracking are simulated. No affiliation with Zomato.
            </p>
            <div className="flex flex-wrap items-center gap-4">
              <a
                href="/pos"
                data-testid="open-pos-terminal"
                className="text-emerald-400 font-bold flex items-center gap-1 hover:underline"
              >
                <Store className="w-3.5 h-3.5" />
                Restaurant Billing Terminal (Staff)
              </a>
              <button
                type="button"
                data-testid="open-rea-inspector"
                onClick={() => setReaInspectorOpen(true)}
                className="text-emerald-400 font-bold flex items-center gap-1 hover:underline"
              >
                <Cpu className="w-3.5 h-3.5" />
                Developer Inspector
              </button>
            </div>
          </div>
        </div>
      </footer>

      {/* Modals & Drawers */}
      {selectedRestaurant && (
        <RestaurantDetailModal
          key={selectedRestaurant.restaurant.resId}
          restaurant={selectedRestaurant.restaurant}
          initialTab={selectedRestaurant.initialTab}
          theme={theme}
          isDark={isDark}
          isGoldMember={isGoldMember}
          onClose={() => setSelectedRestaurant(null)}
          onAddToCart={handleAddToCart}
          onCreateReservation={(booking) => {
            if (account) {
              dispatchAccount({
                type: "RESERVATION_ADDED",
                epoch: accountState.epoch,
                reservation: booking,
              });
            } else {
              guestReservationsStore.set((previous) => upsertReservation(previous, booking));
            }
            notify(
              "RESERVATION",
              `Table confirmed at ${booking.restaurantName}`,
              `${booking.date} at ${booking.timeSlot} for ${booking.guests} guests · ${booking.bookingId}`
            );
            showToast(
              `Table booked at ${booking.restaurantName} for ${booking.guests} guests!`
            );
          }}
          reservations={reservations}
          unavailableItemIds={unavailableItemIds}
          onToggleAvailability={handleToggleAvailability}
        />
      )}

      <CartCheckoutDrawer
        isOpen={cartOpen}
        onClose={() => setCartOpen(false)}
        theme={theme}
        isDark={isDark}
        items={cartItems}
        quote={cartQuote}
        coupons={COUPON_OFFERS}
        appliedCoupon={appliedCoupon}
        couponBlockedReason={couponBlockedReason}
        onApplyCoupon={(code) => updateSession("couponCode", code)}
        riderTip={riderTip}
        onSelectRiderTip={(tip) => updateSession("riderTip", tip)}
        isGoldMember={isGoldMember}
        onToggleGold={handleToggleGold}
        currentAddress={currentAddress}
        onUpdateQuantity={handleUpdateCartQuantity}
        onClearCart={() => updateSession("cartItems", [])}
        onPlaceOrder={() => handlePlaceOrder()}
        paymentMethod={paymentMethod}
        onSelectPaymentMethod={setPaymentMethod}
        checkoutPending={checkoutPending}
        checkoutError={checkoutError}
        scheduledSlot={scheduledSlot}
        onSelectScheduledSlot={(slot) => updateSession("scheduledSlot", slot)}
        unavailableItemIds={unavailableItemIds}
        handling={handling}
        onChangeHandling={(next) => updateSession("handling", next)}
        priceLockExpiresAt={priceLock?.expiresAt ?? null}
      />

      {crystalModalOpen && (
        <CrystalLiveTrackingModal
          order={activeCrystalOrder}
          theme={theme}
          isDark={isDark}
          onClose={() => setCrystalModalOpen(false)}
          onAdvanceStage={handleAdvanceCrystalStage}
        />
      )}

      <ReaInspectorModal
        isOpen={reaInspectorOpen}
        onClose={() => setReaInspectorOpen(false)}
        theme={theme}
        isDark={isDark}
        onInvokeWebMcpTool={invokeWebMcpTool}
      />

      <BrandThemeModal
        isOpen={brandStudioOpen}
        onClose={() => setBrandStudioOpen(false)}
        currentTheme={theme}
        onSelectPreset={(preset) => {
          updateSession("themeId", preset.id);
          setThemeEdits(null);
          showToast(`Applied ${preset.name} theme`);
        }}
        onUpdateCustomBrand={(updates) =>
          setThemeEdits((previous) => ({
            themeId: theme.id,
            updates: { ...(previous?.themeId === theme.id ? previous.updates : {}), ...updates },
          }))
        }
        isDark={isDark}
      />

      {offersOpen && (
        <OverlayDialog
          isOpen={offersOpen}
          onClose={() => setOffersOpen(false)}
          label="Coupons and partner offers"
        >
          <div
            className={`space-y-4 rounded-3xl border p-6 ${
              isDark ? "bg-[#121721] border-white/15 text-white" : "bg-white border-slate-200"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-black">Coupons & Partner Offers</h2>
                <p className="text-xs opacity-65">
                  Applied at checkout against your cart total. All discounts are demo values.
                </p>
              </div>
              <button
                type="button"
                aria-label="Close offers"
                onClick={() => setOffersOpen(false)}
                className="rounded-lg p-1 hover:bg-white/10"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <ul className="space-y-2">
              {COUPON_OFFERS.map((offer) => (
                <li
                  key={offer.code}
                  data-testid={`offer-${offer.code}`}
                  className={`rounded-2xl border p-3.5 ${
                    isDark ? "bg-[#0E131D] border-white/10" : "bg-slate-50 border-slate-200"
                  }`}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="font-black text-sm" style={{ color: theme.primaryHex }}>
                      {offer.code}
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        updateSession("couponCode", offer.code);
                        setOffersOpen(false);
                        setCartOpen(true);
                        showToast(`${offer.code} selected. It applies if your cart qualifies.`);
                      }}
                      className="px-3 py-1.5 rounded-xl text-[11px] font-black text-white"
                      style={{ backgroundColor: theme.primaryHex }}
                    >
                      Use Code
                    </button>
                  </div>
                  <p className="mt-1 text-xs font-bold">{offer.title}</p>
                  <p className="text-[11px] opacity-70">{offer.description}</p>
                  <p className="mt-1 text-[10px] opacity-60">
                    {offer.bankOrPartner} · Minimum order ₹{offer.minOrder}
                    {offer.discountType === "PERCENT" ? ` · Capped at ₹${offer.maxDiscount}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          </div>
        </OverlayDialog>
      )}

      {inboxOpen && (
        <OverlayDialog
          isOpen={inboxOpen}
          onClose={() => setInboxOpen(false)}
          label="Notifications"
        >
          <div
            className={`space-y-4 rounded-3xl border p-6 ${
              isDark ? "bg-[#121721] border-white/15 text-white" : "bg-white border-slate-200"
            }`}
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-black">Notifications</h2>
                <p className="text-xs opacity-65">
                  Saved on this device only. Nothing is pushed or emailed.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {notifications.length > 0 && (
                  <button
                    type="button"
                    data-testid="clear-notifications"
                    onClick={() => {
                      if (!account) {
                        guestNotificationsStore.set([]);
                        return;
                      }
                      dispatchAccount({ type: "NOTIFICATIONS_CLEARED", epoch: accountState.epoch });
                      postJson("/api/webroutes/account/notifications/clear", {}).catch(() => {
                        showToast("Could not clear notifications on your account.");
                        void refreshAccount();
                      });
                    }}
                    className="text-[11px] font-bold opacity-70 hover:opacity-100 underline"
                  >
                    Clear
                  </button>
                )}
                <button
                  type="button"
                  aria-label="Close notifications"
                  onClick={() => setInboxOpen(false)}
                  className="rounded-lg p-1 hover:bg-white/10"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {notifications.length === 0 ? (
              <p className="text-xs opacity-65">
                No notifications yet. Place a demo order or book a table to see updates here.
              </p>
            ) : (
              <ul className="max-h-96 space-y-2 overflow-y-auto">
                {notifications.map((entry) => (
                  <li
                    key={entry.id}
                    data-testid="notification-entry"
                    className={`rounded-2xl border p-3 ${
                      isDark ? "bg-[#0E131D] border-white/10" : "bg-slate-50 border-slate-200"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] font-black uppercase tracking-wider opacity-60">
                        {entry.kind}
                      </span>
                      <span className="text-[10px] opacity-55">
                        {new Date(entry.createdAt).toLocaleString()}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs font-bold">{entry.title}</p>
                    <p className="text-[11px] opacity-70">{entry.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </OverlayDialog>
      )}
      <AccountDialog
        isOpen={accountOpen}
        onClose={() => setAccountOpen(false)}
        theme={theme}
        isDark={isDark}
        user={account}
        onAuthenticated={handleAuthenticated}
        onSignOut={handleSignOut}
      />
    </div>
  );
}
