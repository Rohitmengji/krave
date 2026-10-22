# ADR 0001: Server-Validated Catalog Pricing and Revalidated Local Order History

## Status

Accepted

## Context

In food-ordering prototypes, trusting client-supplied unit prices, modifier totals, or unvalidated `localStorage` payloads creates two failure modes:

1. Manipulated or stale client state can produce negative, `NaN`, or mismatched totals during checkout.
2. Persisted browser history can crash the UI after a catalog schema change or manual `localStorage` edit.

## Decision

- All cart mutations (`addOrIncrementCartItem`, `updateCartLineQuantity`, `calculateCartQuote`) enforce safe positive integer quantities and single-restaurant cart invariants in `src/lib/cartEngine.ts`.
- Checkout (`POST /api/webroutes/order/makeOrder`) accepts only item IDs, modifier option IDs, quantities, address ID, coupon code, membership flag, and tip. `validateCheckout` in `src/lib/checkout.ts` rebuilds every line item and modifier price from the server catalog and rejects unknown items, unserviceable addresses, or violated modifier group constraints (`minSelect` / `maxSelect`).
- `restoreOrderHistory` and `restoreReservationHistory` revalidate stored browser records against the current catalog on hydration and discard malformed entries without throwing.

## Consequences

- Client and server totals are guaranteed to use the same pricing rules.
- Corrupted or stale `localStorage` entries degrade gracefully to an empty or filtered list rather than crashing hydration.
