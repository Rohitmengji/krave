import type { AccountUser } from "@/components/AccountDialog";
import type { DineInBill } from "@/lib/server/dineInStore";
import type { Dispute } from "@/lib/server/disputeStore";
import {
  restoreNotifications,
  restoreOrderHistory,
  restoreReservationHistory,
  type KraveNotification,
} from "@/lib/checkout";
import type { CrystalOrderStage, CrystalOrderState, DiningReservation } from "@/types/krave";

/**
 * What a signed-in account owns. It lives only in memory: it is never written to browser
 * storage, so signing out cannot leave one person's orders or inbox behind for the next
 * guest, and signing in does not touch the guest history saved on this device.
 */
export interface AccountData {
  user: AccountUser;
  orders: CrystalOrderState[];
  reservations: DiningReservation[];
  bookmarks: number[];
  notifications: KraveNotification[];
  dineInBills: DineInBill[];
  disputes: Dispute[];
}

export interface AccountState {
  /**
   * Bumped whenever the signed-in identity changes. A request records the epoch it started
   * in, and its response is dropped if the epoch has moved on, so a reply that was in flight
   * during sign-out cannot sign the browser back in or show one account another's data.
   */
  epoch: number;
  data: AccountData | null;
}

export const INITIAL_ACCOUNT_STATE: AccountState = { epoch: 0, data: null };

export type AccountAction =
  | { type: "SIGNED_IN"; payload: unknown }
  | { type: "SIGNED_OUT" }
  | { type: "SERVER_STATE"; epoch: number; payload: unknown }
  | { type: "ORDER_PLACED"; epoch: number; order: CrystalOrderState }
  | { type: "ORDER_STAGE"; epoch: number; orderId: string; stage: CrystalOrderStage }
  | { type: "RESERVATION_ADDED"; epoch: number; reservation: DiningReservation }
  | { type: "BOOKMARK_SET"; epoch: number; resId: number; saved: boolean }
  | { type: "GOLD_SET"; epoch: number; isGoldMember: boolean }
  | { type: "NOTIFICATIONS_READ"; epoch: number }
  | { type: "NOTIFICATIONS_CLEARED"; epoch: number };

/** Newest first, one entry per order: a replayed checkout returns the same order again. */
export function upsertOrder(
  history: CrystalOrderState[],
  order: CrystalOrderState
): CrystalOrderState[] {
  return [order, ...history.filter((entry) => entry.orderId !== order.orderId)].slice(0, 50);
}

export function upsertReservation(
  history: DiningReservation[],
  reservation: DiningReservation
): DiningReservation[] {
  return [
    reservation,
    ...history.filter((entry) => entry.bookingId !== reservation.bookingId),
  ];
}

export function toggleBookmark(bookmarks: number[], resId: number, saved: boolean): number[] {
  if (saved) return bookmarks.includes(resId) ? bookmarks : [...bookmarks, resId];
  return bookmarks.includes(resId) ? bookmarks.filter((id) => id !== resId) : bookmarks;
}

interface ServerPayload {
  /** `null` is the server saying there is no session; `undefined` means "not included". */
  user?: AccountUser | null;
  orders?: CrystalOrderState[];
  reservations?: DiningReservation[];
  bookmarks?: number[];
  notifications?: KraveNotification[];
  dineInBills?: DineInBill[];
  disputes?: Dispute[];
}

function readUser(value: unknown): AccountUser | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== "object") return undefined;
  const user = value as Record<string, unknown>;
  if (
    typeof user.id !== "string" ||
    typeof user.email !== "string" ||
    typeof user.displayName !== "string" ||
    typeof user.isGoldMember !== "boolean"
  ) {
    return undefined;
  }
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    isGoldMember: user.isGoldMember,
  };
}

export function readServerPayload(raw: unknown): ServerPayload {
  const body = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const payload: ServerPayload = {};
  if ("user" in body) payload.user = readUser(body.user);
  if (Array.isArray(body.orders)) payload.orders = restoreOrderHistory(JSON.stringify(body.orders));
  if (Array.isArray(body.reservations)) {
    payload.reservations = restoreReservationHistory(JSON.stringify(body.reservations));
  }
  if (Array.isArray(body.bookmarks)) {
    payload.bookmarks = body.bookmarks.filter(
      (id): id is number => typeof id === "number" && Number.isSafeInteger(id)
    );
  }
  if (Array.isArray(body.notifications)) {
    payload.notifications = restoreNotifications(JSON.stringify(body.notifications));
  }
  if (Array.isArray(body.dineInBills)) payload.dineInBills = body.dineInBills as DineInBill[];
  if (Array.isArray(body.disputes)) payload.disputes = body.disputes as Dispute[];
  return payload;
}

function emptyAccount(user: AccountUser): AccountData {
  return {
    user,
    orders: [],
    reservations: [],
    bookmarks: [],
    notifications: [],
    dineInBills: [],
    disputes: [],
  };
}

function merge(base: AccountData, payload: ServerPayload): AccountData {
  return {
    user: payload.user ?? base.user,
    orders: payload.orders ?? base.orders,
    reservations: payload.reservations ?? base.reservations,
    bookmarks: payload.bookmarks ?? base.bookmarks,
    notifications: payload.notifications ?? base.notifications,
    dineInBills: payload.dineInBills ?? base.dineInBills,
    disputes: payload.disputes ?? base.disputes,
  };
}

function updateData(
  state: AccountState,
  epoch: number,
  change: (data: AccountData) => AccountData
): AccountState {
  if (epoch !== state.epoch || !state.data) return state;
  const data = change(state.data);
  return data === state.data ? state : { ...state, data };
}

export function accountReducer(state: AccountState, action: AccountAction): AccountState {
  switch (action.type) {
    case "SIGNED_IN": {
      const payload = readServerPayload(action.payload);
      if (!payload.user) return state;
      return { epoch: state.epoch + 1, data: merge(emptyAccount(payload.user), payload) };
    }
    case "SIGNED_OUT":
      return { epoch: state.epoch + 1, data: null };
    case "SERVER_STATE": {
      if (action.epoch !== state.epoch) return state;
      const payload = readServerPayload(action.payload);
      if (payload.user === null) {
        // The session ended elsewhere (expired, or "sign out everywhere" on another device).
        return state.data ? { epoch: state.epoch + 1, data: null } : state;
      }
      if (payload.user && state.data && payload.user.id !== state.data.user.id) {
        // Another tab signed in as someone else; nothing of the old account may carry over.
        return { epoch: state.epoch + 1, data: merge(emptyAccount(payload.user), payload) };
      }
      const base = state.data ?? (payload.user ? emptyAccount(payload.user) : null);
      return base ? { ...state, data: merge(base, payload) } : state;
    }
    case "ORDER_PLACED":
      return updateData(state, action.epoch, (data) => ({
        ...data,
        orders: upsertOrder(data.orders, action.order),
      }));
    case "ORDER_STAGE":
      return updateData(state, action.epoch, (data) => ({
        ...data,
        orders: data.orders.map((order) =>
          order.orderId === action.orderId ? { ...order, stage: action.stage } : order
        ),
      }));
    case "RESERVATION_ADDED":
      return updateData(state, action.epoch, (data) => ({
        ...data,
        reservations: upsertReservation(data.reservations, action.reservation),
      }));
    case "BOOKMARK_SET":
      return updateData(state, action.epoch, (data) => {
        const bookmarks = toggleBookmark(data.bookmarks, action.resId, action.saved);
        return bookmarks === data.bookmarks ? data : { ...data, bookmarks };
      });
    case "GOLD_SET":
      return updateData(state, action.epoch, (data) =>
        data.user.isGoldMember === action.isGoldMember
          ? data
          : { ...data, user: { ...data.user, isGoldMember: action.isGoldMember } }
      );
    case "NOTIFICATIONS_READ":
      return updateData(state, action.epoch, (data) => ({
        ...data,
        notifications: data.notifications.map((entry) =>
          entry.read ? entry : { ...entry, read: true }
        ),
      }));
    case "NOTIFICATIONS_CLEARED":
      return updateData(state, action.epoch, (data) => ({ ...data, notifications: [] }));
  }
}
