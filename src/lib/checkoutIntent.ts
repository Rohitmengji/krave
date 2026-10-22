import { newId } from "./ids";

/**
 * One checkout intent maps to one `Idempotency-Key`.
 *
 * A key minted per click defeats the server's replay check: if the first request commits but
 * its response is lost (timeout, dropped connection, refresh), the retry carries a new key and
 * writes a second order. So the key is kept for as long as the customer is retrying the *same*
 * order, survives a reload of the tab, and is discarded only on a confirmed success or when
 * the order itself changes (a different cart is a different intent).
 */
export interface CheckoutIntent {
  key: string;
  fingerprint: string;
}

type IntentStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export const CHECKOUT_INTENT_STORAGE_KEY = "krave.checkoutIntent";

/** Per-tab storage, so a reload keeps the key but a second tab is its own intent. */
function tabStorage(): IntentStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    // Reading the property itself throws when storage is blocked (sandboxed frames).
    return undefined;
  }
}

/**
 * Everything that defines *what* is being ordered. The price-lock token is excluded because it
 * can be re-issued between attempts without the customer changing anything.
 */
export function checkoutFingerprint(request: { priceLock?: unknown } & Record<string, unknown>): string {
  const { priceLock: _priceLock, ...intent } = request;
  return JSON.stringify(intent);
}

export function resolveCheckoutIntent(
  fingerprint: string,
  previous: CheckoutIntent | null,
  mint: () => string = newId
): CheckoutIntent {
  return previous?.fingerprint === fingerprint ? previous : { key: mint(), fingerprint };
}

export function readCheckoutIntent(storage: IntentStorage | undefined = tabStorage()): CheckoutIntent | null {
  try {
    const raw = storage?.getItem(CHECKOUT_INTENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof (parsed as CheckoutIntent).key === "string" &&
      (parsed as CheckoutIntent).key.length > 0 &&
      typeof (parsed as CheckoutIntent).fingerprint === "string"
    ) {
      return { key: (parsed as CheckoutIntent).key, fingerprint: (parsed as CheckoutIntent).fingerprint };
    }
  } catch {
    // Storage can be disabled or full (private browsing); the in-memory copy still dedupes.
  }
  return null;
}

export function writeCheckoutIntent(
  intent: CheckoutIntent | null,
  storage: IntentStorage | undefined = tabStorage()
): void {
  try {
    if (intent) storage?.setItem(CHECKOUT_INTENT_STORAGE_KEY, JSON.stringify(intent));
    else storage?.removeItem(CHECKOUT_INTENT_STORAGE_KEY);
  } catch {
    // Same as above: losing persistence only weakens the reload case, never the retry case.
  }
}
