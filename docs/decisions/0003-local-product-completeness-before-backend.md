# ADR 0003: Completing the Local Product Before Adding a Backend

## Status

Accepted

## Context

The storefront and the dine-in terminal each worked, but the product had day-one holes that
no backend would fix: the cart and every preference reset on refresh, a confirmed order could
not be withdrawn, a fired kitchen ticket could not be reprinted, two tables could not be
combined onto one bill, there was no cash-up, and a confirmed reservation had no path into the
terminal. The next obvious milestone was accounts and a database, which would have layered
persistence over an incomplete product.

## Decision

- Finish the local product loop first. Add session restore, order cancellation, ticket reprint,
  table merge, shift close with a Z-report, a reservation handoff into `/pos`, and an offline
  shell. Defer accounts, a database, a payment sandbox, and a merchant desk.
- Persist the browsing session by item and option ID only. Prices are rebuilt by `cartEngine`
  on restore, so storage can never set what a customer pays. This keeps the same trust boundary
  the checkout validator already enforces.
- Keep kitchen tickets on the session rather than regenerating them. A reprint must show what
  the kitchen received, so a later void cannot rewrite it.
- Mark a merged table `MERGED` rather than deleting it, so a bill can never be settled twice,
  and renumber moved tickets into the destination sequence so one bill cannot hold two tickets
  with the same number.
- Scope a Z-report to the shift a table was opened under, falling back to outlet and settlement
  time for tables opened before any shift existed, so an earlier session is not silently dropped.
- Cache only the app shell and static assets offline. Never cache `/api/` responses.

## Consequences

- `/pos` is usable as a counter terminal for a full service period, including cash-up.
- A refresh no longer costs the customer their cart or their settings.
- The browser remains the only store. Nothing here makes the data durable, shared between
  devices, or auditable; that still requires the deferred database work.
- Checkout still needs the network. Only the terminal runs fully offline, and the README says so.
- No payment is taken anywhere. Card and UPI tenders record that money was collected at the
  counter; they do not charge anything.
