# ADR 0004: Optional Accounts on a Local SQLite File

## Status

Accepted

## Context

Everything the product produced lived in one browser. Clearing storage destroyed a customer's
order history, the same person on a second device looked like a new visitor, and the demo API
had no identity to scope anything by. The local product loop was complete enough that the next
honest step was durable identity, not a payment provider.

## Decision

- Store accounts and their orders, reservations and bookmarks in a single SQLite file under
  `.data/`, using Node's built-in `node:sqlite`. This is a single-machine demo; a hosted
  Postgres project would add operational weight and a network dependency for no benefit.
  Node still marks that module experimental, which the README states.
- Add no dependencies. Passwords use `scrypt` from `node:crypto` with a per-user random salt
  and a constant-time comparison. A login attempt for an unknown email still performs a hash
  so account existence cannot be timed.
- Keep session tokens out of the database in usable form: store only a SHA-256 digest, and
  deliver the token in an HttpOnly, SameSite=Lax cookie that is Secure in production.
- Keep the existing validators as the trust boundary. An order row stores the inputs, not the
  totals, and is replayed through `createDemoOrder` on read. A tampered `grand_total` therefore
  cannot change what the customer is shown.
- Accept an `Idempotency-Key` on checkout and return the original order when one is replayed,
  so a retried submit cannot create a second order.
- Make signing in optional. Logged out, the app behaves exactly as it did before, which keeps
  the offline shell and the dine-in terminal usable with no server at all.

## Consequences

- A customer's history survives clearing browser storage, and two accounts cannot see or modify
  each other's orders.
- The API route segment is now `force-dynamic` because it reads cookies. The storefront,
  restaurant pages and terminal remain static, so installing and offline reload still work.
- The database holds password hashes, so `.data/` is gitignored and must never be committed.
- This is still not production auth. There is no email verification, password reset, rate
  limiting, lockout, or account recovery, and the README says so.
- The dine-in terminal still writes to `localStorage` only. Moving it onto this database with
  an offline queue is the next step, not something this change claims.
