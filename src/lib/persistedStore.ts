/**
 * One browser-storage key exposed as an external store for `useSyncExternalStore`.
 *
 * Why not `useState` plus an effect that writes everything back: a tab holds a copy taken
 * when it loaded, so writing that copy back erases whatever another tab saved since (an
 * order placed in tab B disappears when tab A changes its theme). Here the stored text is
 * the source of truth: every update is computed from what is in storage *now*, and other
 * tabs' writes arrive through the `storage` event.
 */

export interface StorageArea {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface StorageChange {
  key: string | null;
  storageArea?: unknown;
}

export interface StorageEvents {
  addEventListener(type: "storage", listener: (event: StorageChange) => void): void;
  removeEventListener(type: "storage", listener: (event: StorageChange) => void): void;
}

export interface PersistedStoreOptions<T> {
  key: string;
  /** Stored text (null when absent) to a value. Storage is user-editable: validate, never trust. */
  parse: (raw: string | null) => T;
  serialize: (value: T) => string;
  storage?: () => StorageArea | null;
  events?: () => StorageEvents | null;
  /** The value is kept in memory for this visit when it cannot be written. */
  onWriteError?: (error: unknown) => void;
}

export type Update<T> = T | ((current: T) => T);

export interface PersistedStore<T> {
  readonly key: string;
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => T;
  getServerSnapshot: () => T;
  /** Applies `update` to the latest stored value and returns the result. */
  set: (update: Update<T>) => T;
}

function browserStorage(): StorageArea | null {
  return typeof window === "undefined" ? null : window.localStorage;
}

function browserEvents(): StorageEvents | null {
  return typeof window === "undefined" ? null : (window as unknown as StorageEvents);
}

export function createPersistedStore<T>(options: PersistedStoreOptions<T>): PersistedStore<T> {
  const { key, serialize } = options;
  const storage = options.storage ?? browserStorage;
  const events = options.events ?? browserEvents;
  const fallback = options.parse(null);
  const parse = (raw: string | null): T => {
    try {
      return options.parse(raw);
    } catch {
      return fallback;
    }
  };

  // `current` is the value for the stored text `seenRaw`. Caching by text keeps snapshots
  // referentially stable, which useSyncExternalStore requires to avoid render loops.
  let seenRaw: string | null = null;
  let current = fallback;
  // True while `current` holds a change that could not be written.
  let unsaved = false;
  const listeners = new Set<() => void>();
  let eventTarget: StorageEvents | null = null;

  function read(): T {
    let raw: string | null;
    try {
      raw = storage()?.getItem(key) ?? null;
    } catch {
      // Storage blocked (privacy mode, sandboxed frame): the in-memory value stands in.
      return current;
    }
    if (raw !== seenRaw) {
      seenRaw = raw;
      current = parse(raw);
      unsaved = false;
    }
    return current;
  }

  function emit() {
    for (const listener of [...listeners]) listener();
  }

  function onStorage(event: StorageChange) {
    // A null key means the whole area was cleared.
    if (event.key !== null && event.key !== key) return;
    const area = storage();
    if (event.storageArea && area && event.storageArea !== area) return;
    emit();
  }

  return {
    key,
    subscribe(onChange) {
      listeners.add(onChange);
      if (listeners.size === 1) {
        eventTarget = events();
        eventTarget?.addEventListener("storage", onStorage);
      }
      return () => {
        listeners.delete(onChange);
        if (listeners.size === 0) {
          eventTarget?.removeEventListener("storage", onStorage);
          eventTarget = null;
        }
      };
    },
    getSnapshot: read,
    getServerSnapshot: () => fallback,
    set(update) {
      const previous = read();
      const next =
        typeof update === "function" ? (update as (value: T) => T)(previous) : update;
      if (Object.is(next, previous)) return previous;
      let raw: string;
      try {
        raw = serialize(next);
      } catch (error) {
        current = next;
        unsaved = true;
        options.onWriteError?.(error);
        emit();
        return next;
      }
      // An equal value rebuilt from a server reply: nothing to save and nothing to re-render.
      if (raw === seenRaw && !unsaved) return previous;
      current = next;
      try {
        const area = storage();
        if (!area) throw new Error("Browser storage is not available here.");
        area.setItem(key, raw);
        seenRaw = raw;
        unsaved = false;
      } catch (error) {
        // `seenRaw` still names the old text, so reads keep returning `next` until another
        // tab writes something newer.
        unsaved = true;
        options.onWriteError?.(error);
      }
      emit();
      return next;
    },
  };
}

/** A non-persisted value with the same subscribe/snapshot shape. */
export interface MemoryStore<T> {
  subscribe: (onChange: () => void) => () => void;
  getSnapshot: () => T;
  set: (value: T) => void;
}

export function createMemoryStore<T>(initial: T): MemoryStore<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    getSnapshot: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
