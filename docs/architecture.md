# Architecture

The App Router page is a Server Component that loads the published restaurants and renders
the interactive KraveApp client boundary with them. KraveApp owns the restaurant search,
cart, modal, theme, and local history state. Child components render these values and call
explicit action callbacks. The legacy marketplace engines below still read a static catalog
module, which now ships empty; their unit tests swap in a fictional fixture.

## Checkout

The browser submits item IDs, option IDs, quantities, a saved demo address ID,
coupon, membership flag, tip, and a demo payment choice. The checkout domain
rebuilds line items from the catalog, verifies required modifier groups, and
calculates totals through cartEngine. Client unit prices and totals are ignored.
Quantities must be safe positive integers. Zero removes a line; invalid values
are rejected rather than silently normalized.

The makeOrder handler returns a demo order after validation, or a 400 response.
The UI holds a synchronous submission lock alongside pending state, preserves
the cart on failure, and clears it only after validating a confirmation. Requests
time out after ten seconds. No payment gateway, stock reservation, persistent
server order, auth session, or server idempotency is implemented.

## Local History

History is loaded after mount so server and initial client renders match.
Writes wait until hydration has completed to avoid overwriting saved history.
The versioned localStorage record contains up to 50 demo orders. Its contents
are untrusted and reconstructed against the catalog when read. This is browser
convenience storage, not a durable transaction ledger or an immutable receipt.

Tracking stages are manually simulated and written back to the same history.
Reorder explicitly confirms replacement of an existing cart. Cancellation is
allowed only at the confirmed stage, so a later stage cannot be rewritten.

The browsing session (cart, address, theme, dark mode, discovery mode, membership,
coupon, tip) is saved under its own versioned key. Only item and option IDs are
stored; unit prices are rebuilt by cartEngine when the session is restored. Items
the catalog no longer contains are dropped individually rather than failing the
whole restore.

## Dine-In Terminal

`/pos` is a server page that loads the restaurants the signed-in account may bill (those it
is a member of, or every restaurant that is not suspended for an administrator) with their
orderable dishes, then renders the client terminal over posEngine. Each portion of a dish is
its own terminal item. A table session stores the price
captured when each line was ordered, so a later menu edit cannot move an open bill.
Fired kitchen tickets are retained on the session, which is what makes a reprint show
what the kitchen actually received rather than the table's current state.

Merging moves one open table's lines onto another in the same outlet. The source is
marked MERGED instead of deleted so it can never be settled twice, and moved tickets are
renumbered into the destination's KOT sequence because one bill cannot hold two tickets
with the same number. The destination's discount and service charge stay in force.

A shift records an opening float. Closing it counts the drawer, compares it against the
opening float plus cash settlements, and produces a Z-report. Bills are claimed by the
shift they were opened under; tables opened before any shift existed are claimed by
outlet and settlement time. Closing a shift does not settle open tables.

A confirmed reservation can be handed to the terminal through a single-use storage
record, which the terminal consumes and clears immediately so a refresh cannot reseat it.

## Terminal Sync

`localStorage` remains the terminal's working copy, so a service can be billed with no network
at all. When an account is signed in, changes are pushed to the database shortly after they
settle, and the terminal polls the outlet floor about every 1.5 seconds so another waiter sees
a new item without waiting for a refresh. A failed push leaves the queue on the device and
the header says it is waiting to sync. Open tables belong to the outlet, not to the waiter
who opened them: anyone who can bill that outlet loads and may add to the same floor. A
device with no local floor adopts the outlet's stored one on load.

The payload is never trusted for money. A line the server already holds keeps the price it
was captured at; a new line is priced from the restaurant's menu in the database, including
a dish taken off sale after it was ordered. A table for an outlet the account cannot bill for
is rejected, and stored bills carry the restaurant's own name. Only genuinely off-menu items
keep the operator's price, within the same bounds
the terminal enforces. A table whose price cannot be resolved is rejected individually and
reported, rather than failing the whole sync. Totals are recomputed with `calculatePosBill`,
so a settled figure reflects the server's arithmetic, not the terminal's.

Each stored table carries a revision. A terminal sends the revision it last saw, and a write
based on an older one is rejected with the table named, rather than applied. That turns a
silent overwrite into a visible conflict the operator can act on. Resolution is still manual:
the rejected terminal reloads and redoes its change.

Sync reports two separate buckets. A conflict means another terminal moved first and reloading
fixes it; a rejection means the table cannot be stored as sent, such as an off-menu price
outside the allowed range. The terminal words them differently because only one is worth
retrying.

## Offline Shell

A service worker caches the app shell so `/` and `/pos` reload without a network after
one online visit. Navigations try the network first and fall back to the cached shell;
`/api/` requests are never cached, because a stale confirmation must not be replayed as
a fresh one. The worker itself is served with no-store headers. Checkout still requires
the network: the terminal is the surface that works fully offline.

## Shared Pages

`/restaurant/[resId]` and `/orders` are Server Components that render the same client app
with an initial target, so a link can be shared without duplicating the storefront. The
restaurant route builds its metadata from the catalog and returns a 404 for an unknown id.
`/orders` is marked noindex because it renders only this browser's local history.

## Availability and Notifications

The "86" list lives on the server keyed by outlet, so a dish taken off at the counter
disappears from the storefront, the terminal and checkout at once. Reading it is open, since
every customer needs an honest menu; marking requires a signed-in operator, because one
anonymous visitor must not be able to take a dish off a real menu. The owning outlet is
derived from the catalog, never from the caller. The browser keeps a cached copy only so an
offline menu still shows what was last known to be off.

Checkout refuses an unavailable dish server-side. That check sits beside `validateCheckout`
rather than inside it, because replaying an old order from history must not fail just because
something sold out long after it was delivered.

The notification inbox follows the account. Order confirmations, bookings and scheduled starts
are written server-side, so clearing a browser does not lose them; a signed-out device still
keeps a local inbox. No push service, email, or device notification is involved.

A requested delivery window is validated against a fixed list and stored with a resolved due
time. There is no background scheduler, so a sweep on the next request after the due time
starts the order and announces it. That is honest about timing rather than pretending a cron
exists.

## Accounts and Storage

The main app asks for an account before it can be used. Creating one needs a name, an email,
a mobile number and a 6 to 8 digit PIN (not a long password). If the account check cannot
reach the server, the local demo stays usable so an offline visit is not a blank screen.
With an account, orders, reservations, bookmarks and membership move to Postgres and the
browser copies of order and reservation history are removed so there is a single source of
truth. PINs are hashed with scrypt over a per-user salt and compared in constant time;
an unknown email still performs a hash so a missing account is not faster to probe. Session
tokens are random, stored only as a SHA-256 digest, and sent in an HttpOnly, SameSite=Lax
cookie that is Secure in production.

Stored orders keep the inputs that produced them, never the totals. Reading an order replays
it through `createDemoOrder`, so an edited row cannot change what a customer is shown to have
paid. Checkout accepts an `Idempotency-Key`; replaying one returns the original order instead
of creating a second. Every account endpoint resolves the user from the cookie and scopes its
query by `user_id`, so one account cannot read or modify another's orders.

Sign-in is throttled on two keys at once, the account and the calling client, so neither a
single account nor a single source can be hammered. The two limits are deliberately far
apart: an account locks after a handful of failures, while the client ceiling is high enough
that one attacker behind a shared address cannot lock out everyone else on it. While an
account is locked the correct password is refused too, which is the point. Password reset
issues a single-use token, signs out every session, and clears both lockouts, because holding
the token already proves more than a password does. The forgot-password endpoint answers
identically for known and unknown addresses so it cannot be used to enumerate accounts.

Routes that take no payload are matched before the JSON body is parsed. Requiring a body on
those has silently broken sign-out twice, so it is asserted in the tests rather than assumed.

The account endpoints read per-request cookies, so the API segment is explicitly dynamic while
the storefront, restaurant pages and terminal stay static and therefore installable offline.

## Kitchen Tickets

A placed delivery order is projected onto the owning outlet's counter as a ticket. This is
the point of owning both sides: a customer's allergy or no-cutlery request reaches the
physical ticket the kitchen works from, rather than sitting in a note nobody reads.

Handling is structured rather than free text, so it can be printed and checked. An allergy
with no stated trigger is rejected at the trust boundary — it looks handled while telling
the kitchen nothing. Critical handling is rendered first on the ticket, before the items.

A ticket carries only what a kitchen needs: items, quantities, options and notes. It has no
customer name, address or phone, so an operator cannot read them off a counter screen.

Tickets move NEW → ACCEPTED → READY, one step at a time and never backwards, because the
timestamps they leave behind are what prep-time measurement is built on. Prep time is
reported as a median and a 90th percentile, and withheld entirely until there are enough
samples to mean anything — a measured spread rather than one padded number.

## Dine-In Bills

A settled table is recorded as a bill with an unguessable claim code printed on the receipt.
The guest enters that code to attach it to their account, which is what lets dine-in and
delivery history meet in one place. Holding the receipt is the proof of presence, so the
counter never records who the guest was and staff never see customer accounts.

The code is single-use and expires after thirty days. Unknown, already-claimed, malformed and
expired codes all return one identical message: the codes are unguessable, so distinguishing
them would only help someone probing. A claim never returns the code itself, which would
otherwise let a claimed bill be passed on.

Totals are recomputed from the catalog when the bill is recorded, for the same reason sync
reprices lines: an offline terminal is not a source of truth about money.

## Boundaries

Route names resemble strings observed in website bundles, but these handlers
are original demo implementations. Unknown endpoints return 404. The booking
and tracking endpoints remain placeholders; the UI does not use them for a
real external integration. The local WebMCP inspector is also a simulation.

Checkout, tracking, offers, and the inbox use native dialog top-layer behavior for focus
containment and restoration. Older overlays still need equivalent keyboard work. Navigation
wraps on narrow viewports; broad WCAG compliance and performance improvements have not been
established by these changes.