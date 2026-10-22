# KRAVE

Independent food-delivery and dining prototype built with Next.js, React,
TypeScript, and Tailwind. Inspired by public Zomato website observations made
with REA, not a complete reconstruction of its proprietary application.
Not affiliated with Zomato. All checkout, payment, booking, and tracking flows
are demonstrations; they do not contact restaurants or collect money.

## Evidence Correction

**No genuine Zomato APK was analyzed.** Earlier Android claims were incorrect:
the saved Android inventory and graph describe a synthetic archive generated
locally, not Zomato's application. See [provenance](rea-evidence/PROVENANCE.md).
Hashes of a synthetic archive cannot validate the original application's
activities, bytecode, signing identity, native libraries, or behavior.

Web graph summaries cover selected public bundles only. Route strings are not
verified API contracts. Restaurant names and some menu fields were informed by
web state; prices, reviews, hygiene claims, and much of the seed catalog are
invented demo data, not a current or verified restaurant feed.

**Allergen data is invented and must never be relied on.** The allergen filter
exists to demonstrate the interaction model, not to keep anyone safe. Every
declaration in the seed catalog was made up. The product deliberately treats an
absent declaration as `UNDECLARED` rather than "free of", so silence is never
rendered as safety — but in a real deployment these values would need to come
from the kitchen under an agreement about who is accountable for them.

## Run Locally

Use Node.js 22.19+ on the 22.x release line, or a compatible newer LTS release,
with npm. Dependencies are locked in package-lock.json.

```sh
npm ci
npm run dev
```

Open http://localhost:3005. For a production preview, stop the development server
and run `npm run build` followed by `npm start`. If port 3005 is occupied, use
`npm run dev -- --port 3006`.

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `KRAVE_DB_PATH` | No | SQLite file location. Defaults to `.data/krave.db`. |
| `KRAVE_QUOTE_SECRET` | In production | HMAC key for checkout price locks. Without it in production, locks are disabled and checkout falls back to live pricing. Development generates a per-process key. |

A price lock holds the quoted total for 10 minutes. It is signed rather than
stored so a signed-out guest can hold one, and it can only ever lower the amount
charged: the server pays the smaller of the locked and current totals, and any
difference is shown on the bill rather than applied silently.

```sh
npm test
npm run lint
npm run typecheck
npm run build
npm run test:e2e
npm audit --omit=dev
```

The browser suite needs a production build first and starts its own server on port 3099
against a throwaway database, so it leaves your local `.data/` alone. On a fresh checkout
run `npx playwright install chromium` once.

Vitest currently emits a non-fatal configuration loader warning, and Node reports
SQLite as experimental. External photos require network access and may fail
independently of the app. Do not enter real payment credentials or personal
information.

## Implemented

- Delivery, dining, and nightlife browsing; local search, filters, and menus.
- Modifier choices, quantities, coupons, and deterministic demo totals.
- Server-validated demo checkout that rebuilds prices from the catalog.
- Pending/error states, repeat-click protection, and cart clearing on success.
- Local order history, reorder, and simulated tracking retained across refresh.
- Cancellation of a demo order while it is still at the confirmed stage.
- Cart, address, theme, dark mode, discovery mode, coupon, and tip survive a refresh.
- Native checkout/tracking dialogs with focus containment and Escape handling.
- Demo table reservations, reviews, theme presets, and a local tool inspector.
- Shareable pages per restaurant (`/restaurant/<id>`) and for your own history (`/orders`).
- An offers view over the demo coupon list and a scheduled delivery window on checkout.
- A staff "86" list held per outlet on the server: taking a dish off removes it from the
  storefront, the terminal, and checkout for every customer of that outlet at once.
- Kitchen handling requests — allergy, Jain, no onion or garlic, no cutlery — that reach
  the outlet's counter as a ticket, with a critical instruction printed first. An allergy
  with no stated trigger is refused rather than stored.
- Prep time measured from the counter's own accept and ready timestamps, reported as a
  median and 90th percentile once there are enough samples.
- Dine-in bills a guest can attach to their own account with the code printed on the
  receipt, so table and delivery history sit together. The restaurant never learns who
  the guest was.
- A notification inbox that follows the account rather than the browser.
- Optional demo accounts: sign up, sign in, and keep orders, bookings, bookmarks and
  membership in a local SQLite database instead of this browser. Signed out, the app
  still runs entirely on the device.
- A dine-in terminal at `/pos`: tables, kitchen tickets and reprints, voids, discounts,
  service charge, GST, split bills, table transfer, table merge, payments, and shift close
  with a Z-report. Signed in, the floor also syncs to the database and survives clearing
  this browser; signed out or offline, it keeps billing from the device and syncs later.
- Installable offline shell, so `/` and `/pos` reload without a network after one visit.

The order history lives in this browser's localStorage, retains up to 50 orders,
and is not a server receipt. Invalid records are ignored. Restoring history
revalidates it against the current demo catalog; catalog changes may drop old
records or change recalculated totals. Clearing browser storage removes history.
The saved session stores item and option IDs only, never prices, and rebuilds the
cart from the catalog on load.

## Not Implemented

There is no payment provider. Membership is a flag, not an entitlement. The rider,
tracking stages, and ETA are simulated; nothing is dispatched and no location is read.
The terminal's card and UPI tenders only record that a payment was taken; no card is ever
charged and no fiscal report is filed.

A scheduled order starts when its window arrives, but there is no background scheduler:
the sweep runs on the next request after the due time, not at the minute itself, and it
uses the server's local clock. Signed out, the inbox is still browser-only.

There is no staff role. Any signed-in account can open a counter and work its tickets,
which is why a ticket deliberately carries no customer name, address or phone — a counter
has no use for them. Roles are needed before this is more than a demo.

Terminal sync detects a stale write rather than applying it. Each table carries a revision;
a terminal editing an older copy is rejected and told to reload, so a second device cannot
silently overwrite a service in progress. There is still no automatic merge — the rejected
terminal reloads and redoes its change.

Accounts are a local demo. The database is a single SQLite file under `.data/`, created
on first use and ignored by git. Passwords are salted and hashed with scrypt and never
stored in plain text. Sign-in is throttled per account and per client, a reset token can
recover a locked account, and a reset signs out every device. There is still no email
delivery — the reset token is written to the server log instead — and no email
verification. Do not reuse a real password.

## Next Milestones

1. Automatic merge for concurrent terminals, not just conflict detection.
2. Email delivery and verification for reset tokens.
3. Licensed restaurant data and payment-provider sandbox integration with webhooks.
4. Restaurant/merchant operations for accepting and dispatching delivery orders.
5. Authorized genuine Android APK investigation before making parity claims.

See the [product roadmap](docs/ROADMAP.md), [architecture](docs/architecture.md),
and [contributing](CONTRIBUTING.md).
