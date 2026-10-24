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
verified API contracts.

The app ships no restaurants of its own. The storefront, restaurant pages and the dine-in
terminal show only restaurants that owners create and publish from `/owner`, at the prices
they set; an empty database shows an empty state, not sample places. The fictional catalog
earlier builds used (restaurants, brands, offers, prices, reviews and allergen declarations,
all invented) survives only as a unit-test fixture in
[`src/tests/support/legacyCatalog.ts`](src/tests/support/legacyCatalog.ts), so the older
cart and checkout engines stay tested.

Managed menu imports do not infer allergen safety, and the product treats an absent
declaration as undeclared rather than "free of". Owners must verify allergen information
with the kitchen before publishing it.

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

### Add Jagadamba Maratha Khanawali

[`scripts/data/jagadamba-menu.json`](scripts/data/jagadamba-menu.json) holds the restaurant's
31 dishes and prices, transcribed from its two menu boards. Where the hand-painted veg board
disagrees with the printed board (Roti ₹7 or ₹10, Chapati ₹8 or ₹12, Jeera Rice ₹30/50 or
₹40/60), the printed board is used; edit the file if the other is current. To load it:

```sh
node --env-file=.env.local scripts/seed-jagadamba.mjs --owner-email=you@example.com
```

The owner must already have an account. The restaurant is created as a draft with online
ordering off, so the terminal at `/pos` can bill it straight away; add `--publish` to list
it on the storefront. Running it again adds only dishes that are missing and never
overwrites an owner's later edits.

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | Postgres connection string. On Neon use the pooled (`-pooler`) host. |
| `TEST_DATABASE_URL` | For tests | A separate, disposable database; the suite empties every table. Refused if it shares a host with `DATABASE_URL`. |
| `KRAVE_QUOTE_SECRET` | In production | HMAC key for checkout price locks. Without it in production, locks are disabled and checkout falls back to live pricing. Development generates a per-process key. |
| `KRAVE_STAFF_EMAILS` | No | Comma-separated emails treated as staff at every outlet. How the first operator is created. |
| `KRAVE_RESTAURANT_ADMIN_EMAILS` | No | Comma-separated emails allowed to create the first managed restaurant and administer restaurant workspaces. |
| `KRAVE_OPEN_STAFF` | No | Set to `1` to treat **every** signed-in account as staff everywhere. Demo convenience only; never set it on anything real. |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION` | For uploads | Branch-scoped credentials and endpoint for the private Neon Object Storage bucket. |
| `KRAVE_STORAGE_BUCKET` | No | Private restaurant asset bucket name; defaults to `krave-assets`. |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | For password reset | Mail server for reset links. Port 587 must offer STARTTLS (a login is never sent unencrypted); 465 uses TLS from the start. Without `SMTP_HOST`, production refuses reset requests and development writes the link to the server log. |
| `EMAIL_FROM` | No | Sender, e.g. `KRAVE <me@example.com>`. Defaults to `KRAVE` at `SMTP_USER`; required when the server takes no login. Gmail only sends from the signed-in address. |
| `KRAVE_PUBLIC_URL` | In production, off Vercel | Site address used in emailed links, never taken from the request. On Vercel it defaults to the project's production domain. |
| `OPENAI_API_KEY` | Optional | Enables explicit, owner-triggered menu extraction. Uploads do not call the AI provider automatically. |
| `OPENAI_MENU_MODEL` | No | Extraction model override; defaults to `gpt-4o-mini`. |

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
2. Run `node scripts/db-setup.mjs --url="<production DIRECT connection string>"` (see
   [Schema changes](#schema-changes)).
3. Import the repository into Vercel and set `DATABASE_URL` (pooled host),
   `KRAVE_QUOTE_SECRET` (`openssl rand -hex 32`) and `KRAVE_STAFF_EMAILS`. Never set
   `KRAVE_OPEN_STAFF` on a public deployment.
4. For "Forgot password?", also set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER` and `SMTP_PASS`.
   Without them the site still runs, and reset requests are refused rather than issued.
5. For the owner workspace, set the four `AWS_*` storage values and `OPENAI_API_KEY`
   (see [`.env.example`](.env.example)). Each is optional; the dashboard says what is off.

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

## Operations

### Environment variables

Every variable is described in [`.env.example`](.env.example). Production needs
`DATABASE_URL`, `KRAVE_QUOTE_SECRET` and `KRAVE_STAFF_EMAILS`; the rest switch features on.
Only names beginning `NEXT_PUBLIC_` reach the browser, and KRAVE defines none.

| Variable | Needed for | If missing |
| --- | --- | --- |
| `DATABASE_URL` | everything | API routes answer 500; `/api/health` answers 503 |
| `DATABASE_URL_UNPOOLED` | schema changes | `db-setup` falls back to `DATABASE_URL` |
| `KRAVE_QUOTE_SECRET` | checkout price locks | checkout prices from the live catalog |
| `KRAVE_STAFF_EMAILS`, `KRAVE_RESTAURANT_ADMIN_EMAILS` | `/pos`, `/owner` | nobody can create a restaurant |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | password reset | reset requests are refused |
| `KRAVE_PUBLIC_URL` | links in emails (off Vercel) | Vercel's production domain is used |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_REGION` | menu files, dish photos | uploads disabled, with a notice |
| `OPENAI_API_KEY`, `OPENAI_MENU_MODEL` | AI menu extraction | extraction refused; dishes are added by hand |

### Databases

Use three Neon branches and never share one between them: production, a development branch
in `.env.local` as `DATABASE_URL`, and a test branch as `TEST_DATABASE_URL`. The test suites
empty every table on the test branch, and `db-setup --reset` refuses any host that matches
`DATABASE_URL`. Run Vitest and Playwright one at a time, because both reset that branch.

### Schema changes

The schema is [`src/lib/server/pgSchema.ts`](src/lib/server/pgSchema.ts). Every statement is
`CREATE … IF NOT EXISTS` or `ALTER … ADD COLUMN IF NOT EXISTS` with a default, so applying
it twice is harmless, and nothing in it drops or rewrites data. Apply it in order:

1. Development: `npm run db:setup`.
2. Test: `npm run db:setup:test`, then `npm test` and `npm run test:e2e`.
3. Production, before deploying code that needs the change. Take a Neon snapshot or note
   the time, then run `node scripts/db-setup.mjs --url="<production direct URL>"`.

Additive changes go out before the code; a column the old code ignores cannot break it.
Never use `--reset` outside the test branch, and never empty production to remove sample
data. Delete the specific confirmed rows instead.

### Backup and recovery

Neon keeps history for instant restore; the window depends on the plan. To recover:

1. In the Neon console, create a branch from production at a time before the incident.
   Check the data there; production is untouched while you look.
2. Either copy the lost rows back, or restore the production branch to that time.
   Restoring keeps the replaced state as a backup branch, so it can be undone.
3. For an off-platform copy, run `pg_dump` against the direct URL, for example weekly.

Turn on branch protection for the production branch in the Neon console.

### Releases and rollback

A push to `main` deploys production. If a release misbehaves, use **Instant Rollback** on
the previous deployment in Vercel; it does not touch the database. Because schema changes
are additive, the previous build still runs against the newer schema.

### Monitoring

`GET /api/health` checks the database with an 8-second timeout. It answers 200 `ok` or 503
`degraded`, plus which optional features are configured (`uploads`, `menuImport`, `email`),
never their values. Point an uptime monitor at it. It does not report request rates or
error counts, because nothing collects them.

Server errors are written as one JSON line per event, with `level`, `event` and the error,
plus identifiers such as `restaurantId`. Request bodies are never logged; credentials,
connection strings and email addresses are redacted from messages. Read them under **Logs** in Vercel. Useful
events are `restaurant_api_failed`, `menu_extraction_failed`, `health_database_failed` and
`restaurant_order_placed` (order id, restaurant slug and total only; never the customer's
name, phone or address).

### When a dependency is down

- **Database**: pages that need it fail with a generic error, `/api/health` answers 503,
  and the POS keeps billing on the device until it can sync again.
- **AI provider**: the import is marked failed with a reason. The owner can retry it later
  or add dishes by hand. Nothing is published automatically.
- **Storage**: new uploads fail with a message; existing dishes and menus are unaffected.
- **Email**: password reset requests are refused; sign-in still works.
- **Online orders**: if the database is down, checkout fails with a message and the
  restaurant's phone number. The cart and a pending checkout stay on the customer's device;
  placing it again later cannot create a second order (see [Online orders](#online-orders)).
  No notification is sent to the restaurant: the owner sees new orders by keeping
  `/owner` open, which refreshes every 15 seconds and announces new orders.

### Stuck or failed menu imports

An import left `processing` for more than 5 minutes, for example by a timed-out function,
can be retried from the dashboard. To list problem imports:

```sql
SELECT j.id, r.name, j.status, j.error_message, j.updated_at
FROM menu_import_jobs j JOIN managed_restaurants r ON r.id = j.restaurant_id
WHERE j.status = 'failed'
   OR (j.status = 'processing' AND j.updated_at < to_char(now() - interval '5 minutes', 'YYYY-MM-DD"T"HH24:MI:SS'))
ORDER BY j.updated_at DESC;
```

### Online orders

Customers order from `/r/<slug>` and pay at the counter or on delivery, by cash or UPI. No
payment is taken online. Ordering is **off** for every restaurant until the owner presses
**Start taking orders** under *Online ordering* in `/owner`; the owner can pause it at any
time, and can limit it to opening hours set there (in the restaurant's time zone, India by
default; a window such as 18:00–01:00 runs past midnight).

- **Prices come from the server.** The browser sends dish, portion and add-on IDs plus the
  total it showed. The server prices the order from the current menu and refuses it with
  the new total if anything changed, so the customer always confirms what they pay.
- **One checkout, one order.** Each checkout carries a key that the browser keeps until the
  cart changes. A double tap, a timeout or a retry after a dropped connection returns the
  order already placed. The same key with a different cart is refused.
- **History does not change.** Each order stores the dish names, portions, add-ons and
  prices at the time; renaming, repricing or deleting a dish leaves past orders as they were.
- **Lifecycle.** Placed → accepted → preparing → ready → completed, or rejected / cancelled
  with an optional reason. The customer may cancel only while it is still *placed*. A change
  applies only from the status the owner saw, so two devices cannot both move an order.
- **Privacy.** The status page link is the only key to an order and shows no name, phone or
  address. Only the restaurant's own staff can list orders.

To find orders that have waited too long for a response:

```sql
SELECT o.order_number, r.name, o.status, o.customer_phone, o.placed_at
FROM restaurant_orders o JOIN managed_restaurants r ON r.id = o.restaurant_id
WHERE o.status = 'placed'
  AND o.placed_at < to_char(now() - interval '20 minutes', 'YYYY-MM-DD"T"HH24:MI:SS')
ORDER BY o.placed_at;
```

Handle them from the dashboard (Accept or Reject) rather than in SQL, so the change is audited.

### Limits

Online orders are limited to 20 per network and 8 per phone number per 15 minutes, at most
30 lines of up to 20 each, and ₹1,00,000 per order.

Each owner may upload 60 files and extract 10 menu pages per 15 minutes. Each file is at
most 4 MB, and its contents must match the declared type (JPEG, PNG, WebP or PDF). Owner
API requests must come from the site's own origin.

## Implemented

- A storefront that lists only published restaurants, searchable by name or place from the
  header, with an empty state that points owners to `/owner`.
- Modifier choices, quantities, coupons, and deterministic demo totals.
- Server-validated demo checkout that rebuilds prices from the catalog.
- Pending/error states, repeat-click protection, and cart clearing on success.
- Local order history, reorder, and simulated tracking retained across refresh.
- Cancellation of a demo order while it is still at the confirmed stage.
- Cart, address, theme, dark mode, discovery mode, coupon, and tip survive a refresh.
- Native checkout/tracking dialogs with focus containment and Escape handling.
- Demo table reservations, reviews, theme presets, and a local tool inspector.
- A page for your own history (`/orders`). Restaurant pages are `/r/<slug>`.
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
- A dine-in terminal at `/pos` for the restaurants the signed-in account runs, billing from
  their own menus (each portion is its own item): tables, kitchen tickets and reprints,
  voids, discounts, service charge, GST, split bills, table transfer, table merge, payments,
  and shift close with a Z-report. The floor syncs to the database and survives clearing
  this browser; offline, it keeps billing from the device and syncs later. The server
  prices every line from the restaurant's menu, keeps the price a line was rung up at if the
  menu changes mid-meal, and refuses tables for a restaurant the account does not run.
  Tax follows the restaurant's own setting in the owner workspace (the same one online orders
  use; off by default), captured when the table opens. Staff can take each guest's name and
  mobile number and text them the bill or their share of a split from the phone's own SIM:
  an `sms:` link opens the messaging app with the text filled in, so nothing is sent through
  a gateway and every message is sent by a person tapping Send.
- Installable offline shell, so `/` and `/pos` reload without a network after one visit.
- Account settings at `/account`: name and mobile number, email change confirmed by a link
  to the new address (the old one is told), password change that signs other devices out,
  sign-out everywhere, and account deletion behind the password and a typed confirmation.
- Owner workspace at `/owner` for managed restaurant details, menu CRUD, private menu/photo
  uploads, explicitly triggered and rate-limited AI extraction, human review, and draft-only
  import. Dishes can be searched, filtered by status, marked unavailable in one tap and
  deleted after confirmation. Each dish carries a revision, so an edit made on a second
  device against an older copy is refused and reloaded instead of overwriting. Published
  managed menus can be shared at `/r/<slug>`.
- Online ordering from a managed menu, switched on by the owner: portions and add-ons,
  takeaway, dine-in or delivery within listed areas, server-side pricing, duplicate-safe
  checkout, a live status page for the customer, and an order queue in `/owner` with
  accept, prepare, ready, complete, reject and cancel. Payment is offline. See
  [Online orders](#online-orders).

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

The managed-restaurant workflow, including online ordering, is not yet migrated on
production. Before using it with Jagadamba Maratha Khanawali, apply the schema to production
as described in [Schema changes](#schema-changes), then configure storage and AI
credentials if photo uploads and menu extraction are wanted. The older marketplace features
(modifiers, coupons, the demo cart and checkout, table bookings, the outlet 86 list, delivery
tickets and refund claims) ran on the retired sample catalog. Their code and unit tests
remain, but with no restaurants to act on they are unreachable in the app; managed
restaurants use their own ordering flow.

Managed-menu orders are not paid online and do not notify the restaurant by SMS, email or
push; the owner keeps `/owner` open to see them. Customers are not verified: anyone can
place an order with any phone number, within the limits above, and the restaurant should
call back before preparing a large or unusual order.

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
4. Notifications for new managed-menu orders (SMS or WhatsApp to the owner, web push to
   the dashboard), and delivery dispatch.
5. Authorized genuine Android APK investigation before making parity claims.

See the [product roadmap](docs/ROADMAP.md), [architecture](docs/architecture.md),
and [contributing](CONTRIBUTING.md).
