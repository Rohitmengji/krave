import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CartLineItem } from "@/types/krave";

export const QUOTE_LOCK_MINUTES = 10;

/**
 * Locks are signed rather than stored so a guest with no account can still hold one,
 * and so a lock cannot be forged by editing localStorage.
 */
let cachedSecret: Buffer | null = null;
let warned = false;

/**
 * Returns null when locking cannot be done safely. Callers then fall back to live
 * pricing, which is exactly the behaviour locking replaced — so a missing secret
 * degrades this feature instead of taking checkout down with it.
 */
function secret(): Buffer | null {
  if (cachedSecret) return cachedSecret;
  const configured = process.env.KRAVE_QUOTE_SECRET;
  if (configured) {
    cachedSecret = Buffer.from(configured, "utf8");
    return cachedSecret;
  }
  if (process.env.NODE_ENV === "production") {
    if (!warned) {
      warned = true;
      console.warn("KRAVE_QUOTE_SECRET is not set; price locks are disabled.");
    }
    return null;
  }
  // A per-process random key is fine for dev: locks simply stop verifying on restart,
  // which falls back to live pricing rather than to a forgeable one.
  cachedSecret = randomBytes(32);
  return cachedSecret;
}

/**
 * Identifies exactly what was priced. A lock must not survive the cart changing,
 * or someone could price a small cart and then pay that for a larger one.
 */
function cartSignature(key: Buffer, items: CartLineItem[]): string {
  const parts = items
    .map((line) =>
      [
        line.item.id,
        line.quantity,
        line.selectedOptions.map((option) => option.id).sort().join("+"),
      ].join(":")
    )
    .sort();
  return createHmac("sha256", key).update(parts.join("|")).digest("hex").slice(0, 32);
}

export interface QuoteLockClaim {
  signature: string;
  grandTotal: number;
  expiresAt: string;
}

export function issueQuoteLock(
  items: CartLineItem[],
  grandTotal: number,
  now = new Date()
): string | null {
  const key = secret();
  if (!key) return null;

  const claim: QuoteLockClaim = {
    signature: cartSignature(key, items),
    grandTotal,
    expiresAt: new Date(now.getTime() + QUOTE_LOCK_MINUTES * 60_000).toISOString(),
  };
  const body = Buffer.from(JSON.stringify(claim), "utf8").toString("base64url");
  const mac = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify(key: Buffer, token: string): QuoteLockClaim | null {
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;

  const expected = createHmac("sha256", key).update(body).digest("base64url");
  const given = Buffer.from(mac, "utf8");
  const want = Buffer.from(expected, "utf8");
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;

  try {
    const claim = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as QuoteLockClaim;
    if (
      typeof claim.signature !== "string" ||
      !Number.isSafeInteger(claim.grandTotal) ||
      claim.grandTotal < 0 ||
      Number.isNaN(Date.parse(claim.expiresAt))
    ) {
      return null;
    }
    return claim;
  } catch {
    return null;
  }
}

export interface LockedPrice {
  payable: number;
  /** True when the lock actually spared the customer an increase. */
  honoured: boolean;
  /** Set when a lock was presented but could not be used. */
  reason: "EXPIRED" | "CART_CHANGED" | "INVALID" | null;
}

/**
 * Applies a lock to the freshly computed price.
 *
 * The customer is charged the lower of the two, so a lock can only ever help them:
 * it caps an increase without ever blocking a drop, which also removes any reason
 * to hoard locks.
 */
export function applyQuoteLock(
  token: string | null | undefined,
  items: CartLineItem[],
  currentTotal: number,
  now = new Date()
): LockedPrice {
  if (!token) return { payable: currentTotal, honoured: false, reason: null };

  const key = secret();
  if (!key) return { payable: currentTotal, honoured: false, reason: null };

  const claim = verify(key, token);
  // A tampered or stale-key token falls back to live pricing instead of failing
  // checkout; it can never be used to pay less, so there is nothing to defend here.
  if (!claim) return { payable: currentTotal, honoured: false, reason: "INVALID" };
  if (Date.parse(claim.expiresAt) <= now.getTime()) {
    return { payable: currentTotal, honoured: false, reason: "EXPIRED" };
  }
  if (claim.signature !== cartSignature(key, items)) {
    return { payable: currentTotal, honoured: false, reason: "CART_CHANGED" };
  }

  return {
    payable: Math.min(claim.grandTotal, currentTotal),
    honoured: claim.grandTotal < currentTotal,
    reason: null,
  };
}
