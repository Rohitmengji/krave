import {
  AVAILABILITY_KEY,
  BOOKMARKS_STORAGE_KEY,
  DELIVERY_SLOTS,
  EMPTY_HANDLING,
  NOTIFICATIONS_KEY,
  ORDER_HISTORY_KEY,
  RESERVATION_HISTORY_KEY,
  restoreAvailability,
  restoreNotifications,
  restoreOrderHistory,
  restoreReservationHistory,
  restoreSessionState,
  serializeSessionState,
  SESSION_STATE_KEY,
  type KraveSessionState,
} from "@/lib/checkout";
import { BRAND_THEME_PRESETS, SAVED_ADDRESSES } from "@/data/zomatoReconstructedData";
import {
  createMemoryStore,
  createPersistedStore,
  type PersistedStoreOptions,
  type Update,
} from "@/lib/persistedStore";

/**
 * What this browser owns, one store per storage key. Signed-in accounts never write here
 * (see accountState.ts), so these always describe the device's guest.
 */

export const DEFAULT_BOOKMARKS: number[] = [19677790, 301489];

export const DEFAULT_SESSION: KraveSessionState = {
  cartItems: [],
  addressId: SAVED_ADDRESSES[0].id,
  themeId: BRAND_THEME_PRESETS[0].id,
  isDark: true,
  mode: "delivery",
  isGoldMember: true,
  couponCode: "KRAVE50",
  riderTip: 20,
  handling: EMPTY_HANDLING,
  scheduledSlot: DELIVERY_SLOTS[0],
};

export const storageWarning = createMemoryStore<string | null>(null);

function onWriteError() {
  storageWarning.set("Changes could not be saved on this device. They will last only for this visit.");
}

function jsonStore<T>(key: string, parse: (raw: string | null) => T) {
  const options: PersistedStoreOptions<T> = {
    key,
    parse,
    serialize: (value) => JSON.stringify(value),
    onWriteError,
  };
  return createPersistedStore(options);
}

export function restoreBookmarks(raw: string | null): number[] {
  if (raw === null) return DEFAULT_BOOKMARKS;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) &&
      parsed.every((id) => typeof id === "number" && Number.isSafeInteger(id))
      ? (parsed as number[])
      : DEFAULT_BOOKMARKS;
  } catch {
    return DEFAULT_BOOKMARKS;
  }
}

export const guestOrdersStore = jsonStore(ORDER_HISTORY_KEY, restoreOrderHistory);
export const guestReservationsStore = jsonStore(RESERVATION_HISTORY_KEY, restoreReservationHistory);
export const guestNotificationsStore = jsonStore(NOTIFICATIONS_KEY, restoreNotifications);
export const guestBookmarksStore = jsonStore(BOOKMARKS_STORAGE_KEY, restoreBookmarks);
// Cached only so an offline menu still greys out what was last known to be off.
export const availabilityStore = jsonStore(AVAILABILITY_KEY, restoreAvailability);

export const sessionStore = createPersistedStore<KraveSessionState>({
  key: SESSION_STATE_KEY,
  parse: (raw) => restoreSessionState(raw) ?? DEFAULT_SESSION,
  serialize: serializeSessionState,
  onWriteError,
});

/** Change one field of the saved session, computed from the latest stored session. */
export function updateSession<K extends keyof KraveSessionState>(
  field: K,
  update: Update<KraveSessionState[K]>
): void {
  sessionStore.set((session) => {
    const value =
      typeof update === "function"
        ? (update as (current: KraveSessionState[K]) => KraveSessionState[K])(session[field])
        : update;
    return Object.is(value, session[field]) ? session : { ...session, [field]: value };
  });
}
