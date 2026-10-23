import { describe, expect, it, vi } from "vitest";
import {
  createPersistedStore,
  type StorageArea,
  type StorageChange,
  type StorageEvents,
} from "@/lib/persistedStore";
import {
  accountReducer,
  INITIAL_ACCOUNT_STATE,
  upsertOrder,
  type AccountState,
} from "@/lib/accountState";
import { createLatestSync } from "@/lib/latestSync";
import { filtersReducer, INITIAL_FILTERS } from "@/lib/discoveryFilters";
import { addOrIncrementCartItem, removeOrderedLines } from "@/lib/cartEngine";
import { createDemoOrder, DEMO_PAYMENT_METHODS } from "@/lib/checkout";
import { COLLECTIONS_DATA, RESTAURANTS_DATA } from "@/data/zomatoReconstructedData";

// The storefront engines are tested on the legacy fictional catalog, which the app no longer ships.
vi.mock("@/data/zomatoReconstructedData", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/data/zomatoReconstructedData")>()),
  ...(await import("./support/legacyCatalog")).LEGACY_CATALOG,
}));

function fakeStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  const area: StorageArea & { data: Map<string, string> } = {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
  return area;
}

function fakeEvents() {
  const listeners = new Set<(event: StorageChange) => void>();
  const events: StorageEvents & { fire: (event: StorageChange) => void; count: () => number } = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
    fire: (event) => listeners.forEach((listener) => listener(event)),
    count: () => listeners.size,
  };
  return events;
}

function numberListStore(area: StorageArea, events = fakeEvents(), onWriteError?: () => void) {
  return createPersistedStore<number[]>({
    key: "list",
    parse: (raw) => (raw === null ? [] : (JSON.parse(raw) as number[])),
    serialize: (value) => JSON.stringify(value),
    storage: () => area,
    events: () => events,
    onWriteError,
  });
}

describe("Persisted store", () => {
  it("builds each update on what another tab saved, not on this tab's old copy", () => {
    const area = fakeStorage({ list: "[1]" });
    const tab = numberListStore(area);
    expect(tab.getSnapshot()).toEqual([1]);

    // Another tab appends while this one sits idle.
    area.setItem("list", "[2,1]");
    tab.set((previous) => [3, ...previous]);

    expect(JSON.parse(area.data.get("list")!)).toEqual([3, 2, 1]);
  });

  it("returns the same snapshot until the stored text changes", () => {
    const area = fakeStorage({ list: "[1]" });
    const store = numberListStore(area);
    const first = store.getSnapshot();
    expect(store.getSnapshot()).toBe(first);
    area.setItem("list", "[1]");
    expect(store.getSnapshot()).toBe(first);
    area.setItem("list", "[1,2]");
    expect(store.getSnapshot()).not.toBe(first);
  });

  it("wakes subscribers for its own key and for a cleared area only", () => {
    const area = fakeStorage();
    const events = fakeEvents();
    const store = numberListStore(area, events);
    const onChange = vi.fn();
    const unsubscribe = store.subscribe(onChange);

    events.fire({ key: "other", storageArea: area });
    events.fire({ key: "list", storageArea: fakeStorage() });
    expect(onChange).not.toHaveBeenCalled();

    events.fire({ key: "list", storageArea: area });
    events.fire({ key: null, storageArea: area });
    expect(onChange).toHaveBeenCalledTimes(2);

    unsubscribe();
    expect(events.count()).toBe(0);
  });

  it("keeps an unsaveable change for this visit and reports it", () => {
    const area = fakeStorage({ list: "[1]" });
    area.setItem = () => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
    const onWriteError = vi.fn();
    const store = numberListStore(area, fakeEvents(), onWriteError);

    store.set((previous) => [...previous, 2]);
    expect(onWriteError).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toEqual([1, 2]);

    // A newer save from another tab still wins over the unsaved local copy.
    area.data.set("list", "[9]");
    expect(store.getSnapshot()).toEqual([9]);
  });

  it("works from memory when storage cannot be read at all", () => {
    const blocked: StorageArea = {
      getItem: () => {
        throw new DOMException("Blocked", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("Blocked", "SecurityError");
      },
    };
    const store = numberListStore(blocked, fakeEvents(), () => undefined);
    store.set([4]);
    expect(store.getSnapshot()).toEqual([4]);
  });

  it("falls back to the default for stored text it cannot parse", () => {
    const store = numberListStore(fakeStorage({ list: "{not json" }));
    expect(store.getSnapshot()).toEqual([]);
  });

  it("neither rewrites nor re-renders for an equal value", () => {
    const area = fakeStorage({ list: "[1,2]" });
    const setItem = vi.spyOn(area, "setItem");
    const store = numberListStore(area);
    const before = store.getSnapshot();
    const onChange = vi.fn();
    store.subscribe(onChange);

    expect(store.set([1, 2])).toBe(before);
    expect(setItem).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });
});

const CHECKOUT = {
  items: [{ itemId: "ctl_820099425", quantity: 1, optionIds: ["opt_500g"] }],
  addressId: "addr_cp_514",
  paymentMethod: DEMO_PAYMENT_METHODS[0],
  couponCode: "KRAVE50",
  isGoldMember: true,
  riderTip: 20,
};
const ALICE = { id: "usr_a", email: "a@krave.test", displayName: "a", isGoldMember: false };
const BOB = { id: "usr_b", email: "b@krave.test", displayName: "b", isGoldMember: true };

function signedIn(payload: Record<string, unknown> = {}): AccountState {
  return accountReducer(INITIAL_ACCOUNT_STATE, {
    type: "SIGNED_IN",
    payload: { user: ALICE, ...payload },
  });
}

describe("Account state", () => {
  it("ignores a reply that was in flight when the user signed out", () => {
    const before = signedIn();
    const startedIn = before.epoch;
    const out = accountReducer(before, { type: "SIGNED_OUT" });

    const late = accountReducer(out, {
      type: "SERVER_STATE",
      epoch: startedIn,
      payload: { user: ALICE, orders: [] },
    });
    expect(late).toBe(out);
    expect(late.data).toBeNull();
  });

  it("signs out when the server reports the session has ended", () => {
    const state = signedIn();
    const next = accountReducer(state, {
      type: "SERVER_STATE",
      epoch: state.epoch,
      payload: { user: null, guest: true },
    });
    expect(next.data).toBeNull();
    expect(next.epoch).toBe(state.epoch + 1);
  });

  it("starts clean when another tab signed in as someone else", () => {
    const order = createDemoOrder(CHECKOUT);
    const state = signedIn({ orders: [order] });
    expect(state.data?.orders).toHaveLength(1);

    const next = accountReducer(state, {
      type: "SERVER_STATE",
      epoch: state.epoch,
      payload: { user: BOB },
    });
    expect(next.data?.user.id).toBe(BOB.id);
    expect(next.data?.orders).toEqual([]);
    expect(next.epoch).toBe(state.epoch + 1);
  });

  it("merges a partial reply without dropping what it did not mention", () => {
    const state = signedIn({ bookmarks: [7] });
    const order = createDemoOrder(CHECKOUT);
    const next = accountReducer(state, {
      type: "SERVER_STATE",
      epoch: state.epoch,
      payload: { orders: [order] },
    });
    expect(next.data?.orders.map((entry) => entry.orderId)).toEqual([order.orderId]);
    expect(next.data?.bookmarks).toEqual([7]);
  });

  it("drops local changes addressed to an earlier session", () => {
    const state = signedIn();
    const stale = accountReducer(state, {
      type: "BOOKMARK_SET",
      epoch: state.epoch - 1,
      resId: 5,
      saved: true,
    });
    expect(stale).toBe(state);
    const current = accountReducer(state, {
      type: "BOOKMARK_SET",
      epoch: state.epoch,
      resId: 5,
      saved: true,
    });
    expect(current.data?.bookmarks).toEqual([5]);
    // Saving an already-saved restaurant changes nothing.
    expect(
      accountReducer(current, { type: "BOOKMARK_SET", epoch: state.epoch, resId: 5, saved: true })
    ).toBe(current);
  });

  it("keeps one history entry when a checkout replay returns the same order", () => {
    const order = createDemoOrder(CHECKOUT);
    expect(upsertOrder(upsertOrder([], order), order)).toHaveLength(1);
  });
});

describe("Latest-value sync", () => {
  it("sends one request at a time and skips values that were overtaken", async () => {
    const sent: string[] = [];
    const releases: Array<() => void> = [];
    const sync = createLatestSync<string>(
      (value) =>
        new Promise<void>((resolve) => {
          sent.push(value);
          releases.push(resolve);
        })
    );

    const first = sync.push("a");
    const second = sync.push("b");
    const third = sync.push("c");
    await Promise.resolve();
    expect(sent).toEqual(["a"]);

    releases[0]();
    await first;
    await vi.waitFor(() => expect(sent).toEqual(["a", "c"]));
    releases[1]();
    await expect(second).resolves.toBeUndefined();
    await expect(third).resolves.toBeUndefined();
  });

  it("still sends the newest value after an earlier request fails", async () => {
    const sent: number[] = [];
    let fail = true;
    const sync = createLatestSync<number>(async (value) => {
      sent.push(value);
      if (fail) {
        fail = false;
        throw new Error("offline");
      }
    });
    const first = sync.push(1);
    const second = sync.push(2);
    await expect(first).rejects.toThrow("offline");
    await expect(second).resolves.toBeUndefined();
    expect(sent).toEqual([1, 2]);
  });

  it("never sends a value queued by a session that has since ended", async () => {
    const sent: string[] = [];
    let release!: () => void;
    const sync = createLatestSync<string>(
      (value) =>
        new Promise<void>((resolve) => {
          sent.push(value);
          release = resolve;
        })
    );
    const first = sync.push("old-account:a");
    const queued = sync.push("old-account:b");
    await Promise.resolve();
    sync.discard();
    await expect(queued).resolves.toBeUndefined();
    release();
    await first;
    await Promise.resolve();
    expect(sent).toEqual(["old-account:a"]);

    const next = sync.push("new-account:a");
    await Promise.resolve();
    release();
    await next;
    expect(sent).toEqual(["old-account:a", "new-account:a"]);
  });
});

describe("Cart after checkout", () => {
  const restaurant = RESTAURANTS_DATA[0];
  const dishes = restaurant.menus[0].categories.flatMap((category) => category.items);

  it("empties the cart that was ordered", () => {
    const cart = addOrIncrementCartItem([], restaurant, dishes[0], 2);
    expect(removeOrderedLines(cart, cart)).toEqual([]);
  });

  it("keeps what another tab added while checkout was in flight", () => {
    const ordered = addOrIncrementCartItem([], restaurant, dishes[0], 1);
    let current = addOrIncrementCartItem(ordered, restaurant, dishes[0], 2);
    current = addOrIncrementCartItem(current, restaurant, dishes[1], 1);

    const left = removeOrderedLines(current, ordered);
    expect(left.map((line) => [line.item.id, line.quantity])).toEqual([
      [dishes[0].id, 2],
      [dishes[1].id, 1],
    ]);
  });

  it("leaves an unrelated cart untouched", () => {
    const ordered = addOrIncrementCartItem([], restaurant, dishes[0], 1);
    const other = RESTAURANTS_DATA[1];
    const current = addOrIncrementCartItem([], other, other.menus[0].categories[0].items[0], 1);
    expect(removeOrderedLines(current, ordered)).toBe(current);
  });
});

describe("Discovery filters", () => {
  const diningOnly = COLLECTIONS_DATA.find(
    (collection) => collection.modes.includes("dineout") && !collection.modes.includes("delivery")
  )!;
  const shared = COLLECTIONS_DATA.find(
    (collection) => collection.modes.includes("dineout") && collection.modes.includes("delivery")
  )!;

  it("drops a collection the new mode does not list, and keeps one it does", () => {
    const dining = filtersReducer(INITIAL_FILTERS, { type: "SET_MODE", mode: "dineout" });
    const withDiningOnly = filtersReducer(dining, {
      type: "TOGGLE_COLLECTION",
      collectionId: diningOnly.id,
    });
    expect(filtersReducer(withDiningOnly, { type: "SET_MODE", mode: "delivery" }).collectionId)
      .toBeNull();

    const withShared = filtersReducer(dining, { type: "TOGGLE_COLLECTION", collectionId: shared.id });
    expect(filtersReducer(withShared, { type: "SET_MODE", mode: "delivery" }).collectionId).toBe(
      shared.id
    );
  });

  it("clears a hidden collection when the fast-delivery shortcut switches mode", () => {
    let state = filtersReducer(INITIAL_FILTERS, { type: "SET_MODE", mode: "dineout" });
    state = filtersReducer(state, { type: "TOGGLE_COLLECTION", collectionId: diningOnly.id });
    state = filtersReducer(state, { type: "TOGGLE", filter: "fastDeliveryOnly" });

    const shortcut = filtersReducer(state, { type: "SHOW_FAST_DELIVERY" });
    expect(shortcut.mode).toBe("delivery");
    expect(shortcut.collectionId).toBeNull();
    // Arriving from another mode turns the filter on rather than flipping it off.
    expect(shortcut.fastDeliveryOnly).toBe(true);
    expect(filtersReducer(shortcut, { type: "SHOW_FAST_DELIVERY" }).fastDeliveryOnly).toBe(false);
  });

  it("refuses a collection the current mode does not show", () => {
    expect(
      filtersReducer(INITIAL_FILTERS, { type: "TOGGLE_COLLECTION", collectionId: diningOnly.id })
    ).toBe(INITIAL_FILTERS);
  });

  it("resets applied filters but keeps the mode and sort order", () => {
    let state = filtersReducer(INITIAL_FILTERS, { type: "SET_MODE", mode: "nightlife" });
    state = filtersReducer(state, { type: "SET_SORT", sortBy: "rating_desc" });
    state = filtersReducer(state, { type: "SET_QUERY", query: "biryani" });
    state = filtersReducer(state, { type: "TOGGLE", filter: "pureVegOnly" });
    state = filtersReducer(state, { type: "TOGGLE_CUISINE", cuisine: "Cafe" });

    const reset = filtersReducer(state, { type: "RESET" });
    expect(reset).toEqual({ ...INITIAL_FILTERS, mode: "nightlife", sortBy: "rating_desc" });
  });
});
