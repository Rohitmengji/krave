# KRAVE

Independent food-delivery and dining prototype built with Next.js, React,
TypeScript, and Tailwind. Inspired by public Zomato website observations made
with REA, not a complete reconstruction of its proprietary application.
Not affiliated with Zomato. All checkout, payment, booking, and tracking flows
are demonstrations; they do not contact restaurants or collect money.

Live demo: <https://krave-neon.vercel.app>

## Evidence Correction

**No genuine Zomato APK was analyzed.** Earlier Android claims were incorrect:
the saved Android inventory and graph describe a synthetic archive generated
locally, not Zomato's application. See [provenance](rea-evidence/PROVENANCE.md).
Hashes of a synthetic archive cannot validate the original application's
activities, bytecode, signing identity, native libraries, or behavior.

Web graph summaries cover selected public bundles only. Route strings are not
verified API contracts. Restaurant, brand and offer names are fictional; some menu
fields were informed by web state, and prices, reviews, hygiene claims, and much of
the seed catalog are invented demo data, not a current or verified restaurant feed.

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
cp .env.example .env.local   # then fill in DATABASE_URL
npm run db:setup             # creates the tables; safe to run again
npm run dev
```

Open http://localhost:3005. For a production preview, stop the development server
and run `npm run build` followed by `npm start`. If port 3005 is occupied, use
`npm run dev -- --port 3006`.

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection string. On Neon use the pooled (`-pooler`) host. |
| `TEST_DATABASE_URL` | For tests | A separate, disposable database; the suite empties every table. Refused if it shares a host with `DATABASE_URL`. |
| `KRAVE_QUOTE_SECRET` | In production | HMAC key for checkout price locks. Without it in production, locks are disabled and checkout falls back to live pricing. Development generates a per-process key. |
| `KRAVE_STAFF_EMAILS` | No | Comma-separated emails treated as staff at every outlet. How the first operator is created. |
| `KRAVE_OPEN_STAFF` | No | Set to `1` to treat **every** signed-in account as staff everywhere. Demo convenience only; never set it on anything real. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | For password reset | Mail server for reset links. Port 587 must offer STARTTLS (a login is never sent unencrypted); 465 uses TLS from the start. Without `SMTP_HOST`, production refuses reset requests and development writes the link to the server log. |
| `EMAIL_FROM` | No | Sender, e.g. `KRAVE <me@example.com>`. Defaults to `KRAVE` at `SMTP_USER`; required when the server takes no login. Gmail only sends from the signed-in address. |
| `KRAVE_PUBLIC_URL` | In production, off Vercel | Site address used in emailed links, never taken from the request. On Vercel it defaults to the project's production domain. |

### Who may act as staff

Seeing an outlet's tickets, taking a dish off sale, syncing its terminal and settling
refund claims all require staff access to that outlet, held in `outlet_staff`. The
checks live in the stores rather than the route handlers, so a new caller cannot reach
them unauthorised. With neither environment variable set, nobody is staff until a row
is granted — closed by default rather than open by default.

This is outlet-level access, not a full role system: a staff member of an outlet can do
all staff actions for it. There are no separate manager, chef or cashier permissions.

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
against `TEST_DATABASE_URL`, so it leaves your development data alone. On a fresh checkout
run `npx playwright install chromium` once.

Vitest currently emits a non-fatal configuration loader warning. External photos require
network access and may fail independently of the app. Do not enter real payment
credentials or personal information.

## Deploy

The public demo runs on Vercel (region `sin1`) against a Neon Postgres branch in
`aws-ap-southeast-1`, so each query stays inside one region. To deploy your own copy:

1. Create a Neon project and keep production on its own branch; develop and test on
   child branches so the suite never touches real accounts.
2. Run `node scripts/db-setup.mjs --url="<production connection string>"` once.
3. Import the repository into Vercel and set `DATABASE_URL` (pooled host),
   `KRAVE_QUOTE_SECRET` (`openssl rand -hex 32`) and `KRAVE_STAFF_EMAILS`. Never set
   `KRAVE_OPEN_STAFF` on a public deployment.
4. For "Forgot password?", also set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASS`.
   Without them the site still runs, and reset requests are refused rather than issued.

The repository is connected to the Vercel project: a push to `main` deploys production.
Other branches get preview deployments, which receive no production variables and so
never reach the production database.

The pool is attached with `attachDatabasePool`, so an instance drains its connections
before Vercel suspends it rather than waking up with sockets Neon has already closed.

### Public demo limits

These are deliberate for a demo and must be closed before taking real money:

- Payments, the rider and tracking are simulated, and the customer's own browser advances
  the tracking stages. A refund claim therefore trusts a stage the customer could fake;
  arrival must be derived on the server first.
- A guest who cancels is not reported to the kitchen, and guest checkout has no
  idempotency key, so only signed-in checkouts are protected against double submission.
- Password reset emails come from one personal SMTP account, so its provider's daily
  sending cap is the ceiling. Requests are limited to 3 per address and 10 per network
  address per 15 minutes, counted whether or not the account exists.
- Every address may create 30 accounts and place 30 guest orders per 15 minutes; sign-in
  is throttled per account and per address. Limits are stored in Postgres, so they hold
  across serverless instances.
- The reverse-engineering inspector and its evidence endpoint exist only in development.

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
  membership in Postgres instead of this browser. Signed out, the app still runs entirely
  on the device.
- A dine-in terminal at `/pos`: tables, kitchen tickets and reprints, voids, discounts,
  service charge, GST, split bills, table transfer, table merge, payments, and shift close
  with a Z-report. Signed in, the floor also syncs to the database and survives clearing
  this browser; signed out or offline, it keeps billing from the device and syncs later.
- Installable offline shell, so `/` and `/pos` reload without a network after one visit.
- Account settings at `/account`: name and mobile number, email change confirmed by a link
  to the new address (the old one is told), password change that signs other devices out,
  sign-out everywhere, and account deletion behind the password and a typed confirmation.

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

Staff access is per outlet (see [Who may act as staff](#who-may-act-as-staff)), not a role
system. A ticket deliberately carries no customer name, address or phone — a counter has
no use for them.

Terminal sync detects a stale write rather than applying it. Each table carries a revision;
a terminal editing an older copy is rejected and told to reload, so a second device cannot
silently overwrite a service in progress. There is still no automatic merge — the rejected
terminal reloads and redoes its change.

Accounts are a demo. They live in Postgres, created by `npm run db:setup`. Passwords are
salted and hashed with scrypt and never stored in plain text. Sign-in is throttled per
account and per client, a reset token can recover a locked account, and a reset signs out
every device. "Forgot password?" emails a single-use link valid for 30 minutes; the token
rides in the URL fragment, so it never reaches a server log or a Referer header, and the
owner is emailed when the password changes. New accounts get a link to confirm their
address; staff access granted by email does not check that confirmation yet. Do not reuse
a real password.

## Next Milestones

1. Automatic merge for concurrent terminals, not just conflict detection.
2. Require a confirmed address for staff access granted by email, so it cannot be claimed
   by whoever registers the address first.
3. Licensed restaurant data and payment-provider sandbox integration with webhooks.
4. Restaurant/merchant operations for accepting and dispatching delivery orders.
5. Authorized genuine Android APK investigation before making parity claims.

See the [product roadmap](docs/ROADMAP.md), [architecture](docs/architecture.md),
and [contributing](CONTRIBUTING.md).
