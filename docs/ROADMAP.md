# Krave Roadmap — From Prototype to a Better Food Platform

Sizes: **S** ≈ 2–4 days · **M** ≈ 1–2 weeks · **L** ≈ 3–6 weeks (one engineer).
Every item lists what it depends on. Build in dependency order, not phase order, when parallelising.

---

## 0. Baseline (what exists today)

| Area | State |
|---|---|
| Customer storefront | Strong: discovery, search/filters, modifiers, coupons, server-repriced checkout, idempotency, local + account history, reorder, reviews, bookings, offline shell |
| Dine-in POS (`/pos`) | Strong: tables, KOT + reprint, voids, discounts, GST, split, transfer, merge, shifts, Z-report, offline-first, single-device sync |
| Accounts | SQLite + scrypt + hashed session tokens; no roles, rate limiting, OTP, reset |
| Catalog | Hard-coded in `src/data/zomatoReconstructedData.ts` (includes real brand names — replace before any public launch) |
| Order lifecycle | Customer-only. No merchant accepts it, no rider delivers it, tracking is simulated |
| Merchant / Rider / Admin apps | None |
| Payments | None (tenders are recorded only) |
| Realtime | None (polling/simulation) |
| Engineering | No lint, no e2e, no CI; monolith files (`KraveApp.tsx` 1.7k, `PosTerminal.tsx` 2k, catch-all API route) |

**Core gap:** a delivery order goes nowhere. Closing that loop is the top priority.

---

## 1. Strategy: Restaurant-OS first, marketplace second

Zomato-style marketplaces need restaurants, riders and customers on the platform all at once. That is hard to start and very capital-intensive.
Krave already has something most aggregators don't: **a real POS**. So build in this order:

1. **Restaurant OS** — POS, QR table ordering, kitchen display, delivery-order inbox, menu management, CRM. Restaurants adopt it for dine-in **without** needing riders.
2. **Own delivery marketplace** — turn on delivery for restaurants already running on Krave. Their menus, prices, availability and kitchen load are already live.
3. **Platform advantages no pure aggregator can copy easily** — verified price parity with dine-in, ETAs based on how busy the kitchen actually is, one kitchen screen for every order channel.

---

## 2. Critical path (dependency graph)

```
F1 Tooling/CI ─┐
F2 Postgres + migrations ─┬─ F3 Catalog in DB ─┬─ P1 Merchant menu mgmt ─┐
                          │                    └─ server-side 86 list    │
F4 Roles/RBAC ────────────┼──────────────────────────────────────────────┼─ P2 Partner order inbox ─┐
F5 Order state machine + event log ─ F6 Realtime (SSE) ──────────────────┘                          │
F7 API split + validators                                                                           │
                                                                                                    │
P3 Multi-writer POS sync ─┬─ P4 QR table ordering → POS                                             │
                          └─ P5 Unified KDS (dine-in + delivery + takeaway) ◄────────────────────────┘
                                                                                                    │
M1 Payments sandbox + ledger ─┬─ M5 Merchant payouts                                                │
M2 Geo + serviceability zones ┴─ M3 Rider app ─ M4 Dispatch ─ live tracking ◄─────────────────────────┘
```

---

## Phase 0 — Foundations (do first; everything depends on these)

| # | Item | Why | Size | Depends on |
|---|---|---|---|---|
| F1 | **ESLint, Playwright e2e, GitHub Actions CI** (typecheck, unit, e2e, build, audit) | No lint/e2e today; refactors below are risky without them | S | — |
| F2 | **Postgres (+PostGIS) with versioned migrations**, and a repository layer over `db.ts` | Multi-actor writes (merchant, rider, customer) and geo queries outgrow `node:sqlite`. Migrate once, *before* moving the catalog. Write ADR 0005 superseding parts of 0004 | M | F1 |
| F3 | **Catalog in the database**: restaurants, outlets, hours, menu categories, items, modifier groups/options, prices, tax class, availability, images | Merchants must edit menus; `cartEngine`/`checkout` must read prices from the DB, not a TS file | M | F2 |
| F4 | **Roles & RBAC**: `customer`, `merchant_owner`, `merchant_staff`, `rider`, `admin`; outlet membership; permission checks in every handler | Prerequisite for partner/rider/admin surfaces | M | F2 |
| F5 | **Server-authoritative order state machine** + `order_events` (append-only) + transactional outbox | Replaces simulated stages. Every transition is validated, audited and broadcast | M | F2 |
| F6 | **Realtime channel (SSE first)** for order events, POS table events, rider location | Tracking, merchant alerts and multi-terminal sync need push. SSE fits Next route handlers; switch to WebSocket only if needed | S | F5 |
| F7 | **Split the catch-all `/api/webroutes/[...slug]`** into per-domain handlers with shared request validators and a typed error envelope | One 354-line switch won't scale to 4 apps | S | F1 |
| F8 | **Decompose monolith components** (`KraveApp`, `PosTerminal`, `RestaurantDetailModal`) into feature modules | Faster iteration, testability, code-splitting | M | F1 |
| F9 | **Auth hardening**: rate limiting, phone OTP login (India-primary), email verification, password reset, session revocation, CSRF token on mutating routes, security headers/CSP | README milestone #2; required before real users | M | F2, F7 |
| F10 | **Observability**: structured logs, request IDs, error tracking (Sentry/OTel), health endpoint | You can't run a live order pipeline blind | S | F7 |

**Exit criteria:** catalog edits in DB show up in storefront and POS; an order transition emits an event a browser receives over SSE; CI is green on every PR.

---

## Phase 1 — Restaurant OS (close the loop on the restaurant side)

| # | Item | Notes | Size | Depends on |
|---|---|---|---|---|
| P1 | **Merchant menu management** (`/partner/menu`): CRUD items, modifiers, photos, prices, schedules (breakfast menu), item on/off, bulk edit | Server-side **86 list** replaces the device-local overlay | M | F3, F4 |
| P2 | **Partner order inbox** (`/partner/orders`): ring + vibrate on new order, accept/reject with reason, set prep time, mark ready, auto-reject timeout, store pause/resume | Turns delivery orders from simulated into real | M | F4, F5, F6 |
| P3 | **Multi-terminal POS sync** with real conflict handling: server as sequencer, per-session version, operation log (add line / void / settle) instead of last-device-wins | README milestone #1. **Must come before QR ordering**, because customer phones and the terminal will write to the same table | L | F2, F6 |
| P4 | **QR table ordering**: scan → menu → order goes straight to POS as a KOT → "call waiter" → pay at table with split-by-person | Large restaurant pull; reuses `posEngine` | M | P3 |
| P5 | **Unified Kitchen Display (KDS)**: one screen for dine-in, QR, takeaway and delivery tickets; bump/recall; station routing (tandoor, bar, wok); prep timers | Kitchen-ticket throughput becomes the input for ETAs (see D-ETA) | M | P2, P3 |
| P6 | **Takeaway / pickup orders** with pickup OTP | Cheapest new channel — no rider needed | S | P2 |
| P7 | **Inventory & recipe costing**: raw materials, recipe BOM per dish, auto-deduct on sale, low-stock → auto-86, wastage log | Makes the POS sticky; few aggregators do this | L | P1, P3 |
| P8 | **Restaurant CRM**: customer list (consented), visit frequency, campaigns, feedback | Restaurants often complain that aggregators withhold customer data | M | F4, DPDP consent (C2) |
| P9 | **Merchant analytics**: sales by channel/hour/dish, prep-time SLA, rejection rate, ratings | — | M | P2, P5 |
| P10 | **Hardware**: ESC/POS thermal printer + cash drawer via WebUSB/Bluetooth or a local print bridge | Real KOT/bill printing | M | P5 |

**Exit criteria:** a restaurant can run a full day — dine-in, QR, takeaway and delivery acceptance — on Krave across multiple devices without data loss.

---

## Phase 2 — Delivery Marketplace (riders, dispatch, money)

| # | Item | Notes | Size | Depends on |
|---|---|---|---|---|
| M1 | **Payments sandbox** (Razorpay/Cashfree/Stripe test mode): UPI intent/collect, cards via hosted page (no PAN touches you), wallets, COD; signed webhooks; payment state machine; refunds | README milestone #3 | L | F5 |
| M1b | **Double-entry ledger**: every payment, fee, commission, tip, refund and payout is a ledger entry; daily reconciliation against gateway reports | Correct money handling from day one; never patch a balance in place | M | M1 |
| M2 | **Geo layer**: geocoded addresses (lat/lng + pin), serviceability polygons per zone, restaurant delivery radius, distance-based fees, maps provider | PostGIS queries | M | F2 |
| M3 | **Rider app**: online/offline, order offer with **earnings shown before accepting**, navigation hand-off, pickup OTP, delivery OTP / photo proof, COD cash tracking, earnings & payouts | Build native (Expo/React Native): a PWA can't track location reliably in the background | L | F4, F6, M2 |
| M4 | **Dispatch engine v1**: nearest available rider weighted by kitchen-ready time, rider idle time and acceptance; reassignment on timeout; batching (v2) | Run as a separate worker with a job queue (pg-boss or BullMQ) | L | M2, M3, P5 |
| M4b | **Live tracking for real**: rider location over SSE, ETA recomputed from kitchen queue + route time; masked calling | Replaces the simulated tracking modal | M | M3, M4 |
| M5 | **Merchant & rider payouts**: settlement cycles, commission statements, TDS/TCS lines, payout via gateway | — | M | M1b, C1 |
| M6 | **Notifications**: Web Push (VAPID), SMS/WhatsApp, transactional email, templated & localised | Replaces the local inbox | M | F5 |
| M7 | **Customer support**: order-level help ("missing item", "wrong item", "late") with photo; rules-based instant refunds; agent chat; escalation | — | L | M1, F5 |
| M8 | **Scheduled orders that actually fire**: job scheduler releases the order to the kitchen at the right time | Today the window is only recorded | S | F5, P2 |

**Exit criteria:** a paid test-mode order is accepted, cooked, picked up, delivered with OTP, settled in the ledger, and refunded on complaint, with every step visible live.

---

## Phase 3 — Admin & Operations Console (`/admin`)

| # | Item | Size | Depends on |
|---|---|---|---|
| A1 | Restaurant onboarding & KYC: FSSAI licence, GSTIN, PAN, bank (penny-drop), menu import (CSV/photo-OCR), go-live checklist | L | F4, P1 |
| A2 | Rider onboarding: documents, vehicle, background check status, training | M | M3 |
| A3 | Live ops map: orders by stage, riders, delayed-order alerts, manual reassign, zone surge/rain mode, zone pause | L | M4 |
| A4 | Promotions engine: coupon rules, budgets, platform vs merchant funding split, targeting, stacking rules, abuse caps | M | M1b |
| A5 | Fees & commission config per zone/merchant, with versioning and effective dates | M | M1b |
| A6 | Refund/dispute queue, fraud flags (multi-account, refund abuse, COD abuse, fake reviews) | M | M7 |
| A7 | **Immutable audit log** of every admin and merchant action | S | F5 |
| A8 | Feature flags & gradual rollout per zone | S | F7 |

---

## Phase 4 — Discovery, Trust & Growth

| # | Item | Size | Depends on |
|---|---|---|---|
| G1 | Real search: typo-tolerant, dish-level ("paneer tikka under ₹300 near me"), Hinglish synonyms (Typesense/Meilisearch or Postgres trigram+FTS) | M | F3 |
| G2 | Ranking & personalisation: time-of-day, past orders, dietary profile, distance/ETA, rating quality | L | G1, M2 |
| G3 | **Verified-only reviews**: only after a delivered or settled order; dish-level ratings; photo reviews; show "ordered 5×" | M | F5 |
| G4 | **Dining reservations from real table inventory**: slots computed from the POS floor and turn times, plus a waitlist with SMS "your table is ready" | M | P3 |
| G5 | Membership with real entitlements (free delivery threshold, dining discount), billed via payment subscription | M | M1 |
| G6 | Referrals, gift cards, wallet credits (all ledger-backed) | M | M1b |
| G7 | Events / nightlife ticketing (the existing nightlife tab becomes bookable) | L | M1 |

---

## Phase 5 — Differentiators ("better than Zomato")

These features are rare across Indian food apps or address common user complaints. **Bold** marks the ones only a POS-plus-marketplace platform can do well — Krave's real advantage.

### For customers
| ID | Feature | Why it beats the status quo |
|---|---|---|
| **D-PRICE** | **Verified price parity badge**: the app price is checked against the restaurant's actual dine-in POS price | Hidden menu markups are a top complaint; only a POS-integrated platform can verify parity |
| **D-ETA** | **Kitchen-aware ETA**: ETA from the real KOT queue + rider route, with "being cooked now" when the chef bumps the ticket | Honest ETAs instead of fixed guesses |
| D-FEES | All fees on the listing card, quote locked for 10 min after adding to cart, no surprise fees at checkout | Fee transparency |
| D-EDIT | Edit or add to an order until the kitchen accepts or starts it | Common request; easy with the state machine |
| D-GROUP | Group cart with per-person UPI split; office ordering with budgets and GST invoices | Social and corporate ordering |
| D-ALLERGEN | Structured allergens per dish *and* per modifier; "allergy note" the restaurant must acknowledge before cooking | Safety, liability |
| D-DIET | Jain / Satvik / pure-veg-kitchen attestation, nutrition & macros, "meal under 600 kcal" builder | Health and religious diets |
| D-AI | Natural-language ordering: "dinner for 4, ₹1500, 1 Jain, no mushrooms" → editable cart | Fastest path to checkout |
| D-MULTI | Multi-restaurant cart from one food court/cluster with one delivery | Food-court ordering |
| D-BATCH | "Wait 10 min, save ₹20" eco-batched delivery option | Cheaper and greener |
| D-REFUND | Instant, rules-based refund for missing items using photo + weighing data from the kitchen | Trust |
| D-LITE | Low-bandwidth "lite" mode, offline cart, regional languages, voice ordering, full WCAG 2.2 AA | Next 300M users; accessibility |
| D-SUB | Tiffin / meal subscriptions, including home chefs (with FSSAI registration) | Recurring demand |
| D-SURPLUS | End-of-day surplus bags at a discount, driven by POS inventory | Reduces waste; uses inventory data |

### For restaurants
| ID | Feature | Why |
|---|---|---|
| **D-ONEKDS** | **One kitchen screen + one POS for dine-in, QR, takeaway, Krave delivery *and* other aggregators** (ingest orders from other platforms through their partner integrations where permitted) | Becomes the restaurant's operating system, not just a sales channel |
| D-FAIR | Transparent commission per order, fixed settlement timeline, in-app dispute with SLA, no forced discounts | Merchant trust |
| D-OWNDATA | Restaurant owns its customer relationship (consented CRM, own loyalty programme) | Common merchant complaint about aggregators |
| D-FORECAST | Demand forecast & prep suggestions from POS + delivery history (by weather/day/event) | Less waste, faster prep |
| D-STAFF | Staff shifts, attendance, tips pooling, role permissions on the POS | Sticky back-office |
| D-API | Public merchant API + webhooks | Integrations, chains |

### For riders
| ID | Feature | Why |
|---|---|---|
| D-EARN | Full earnings shown before accepting; 100% of tips, itemised | Rider fairness |
| D-WAIT | Paid wait time when the restaurant is late (measured from the KDS ready time); riders rate restaurant handover | Riders aren't penalised for kitchen delays |
| D-SAFE | SOS, accident insurance, heat/rain incentives, rest-point map, women-rider safety features | Welfare |

### For society / environment
| ID | Feature |
|---|---|
| D-ECO | No-cutlery default, packaging choice, reusable-container deposit, per-order carbon estimate |
| D-HYGIENE | FSSAI licence shown and verified, periodic photo audits of kitchens, visible hygiene score with date |

---

## Cross-cutting (runs alongside every phase)

### C1. Compliance (India)
- **GST**: since Jan 2022, the platform (as e-commerce operator) collects and pays GST on restaurant services delivered through it under Section 9(5). Platform fees carry their own GST. Generate tax invoices correctly.
- **TCS/TDS** on merchant payouts; e-invoicing for B2B/corporate orders.
- **FSSAI**: licence number shown per restaurant; verify during onboarding.
- **Payments**: use RBI-authorised payment aggregators and a hosted card page, so you're never in PCI-DSS scope for raw card data.
- **Legal metrology**: show item weights/quantities where required.

### C2. Privacy — DPDP Act 2023
- Consent records, purpose limitation, data export/delete, retention schedules, breach runbook, data processor agreements, masked phone numbers between customer and rider.

### C3. Security
- Rate limiting, bot protection on OTP/login/coupon endpoints, CSP, secret management, dependency scanning, an authorisation test for every endpoint (IDOR suite), PII encryption at rest, regular backups with restore drills.

### C4. Reliability & performance
- Timeouts, retries and an outbox on every external call; queues for dispatch and notifications; load testing ahead of dinner peak.
- SLOs: order placement p95 < 800 ms, event-to-screen < 2 s, 99.9% order pipeline availability.
- Core Web Vitals budgets; image CDN.

### C5. Quality
- Keep the existing quality-gate doc. Add e2e journeys for the full order loop and contract tests between apps. Any feature that moves money must have ledger tests.

### C6. Content & IP
- Replace seed restaurants that use real brand names (e.g. Haldiram's, Farzi Cafe, Bukhara ITC) with fictional or licensed partner data before any public deployment.
- Keep the README's provenance discipline: no parity claims without authorised analysis.

---

## Target architecture

```
apps/
  customer   (Next.js web + PWA)        apps/partner (Next.js: POS, KDS, inbox, menu)
  rider      (Expo React Native)        apps/admin   (Next.js ops console)
services/
  api        (Next route handlers or a separate Node service — split when load demands)
  dispatch-worker, notification-worker, payout-worker (job queue)
packages/
  domain     (cartEngine, checkout, posEngine, order state machine — pure, shared, tested)
  db         (schema, migrations, repositories)
  ui         (shared components, design tokens)
infra: Postgres+PostGIS · Redis (rate limit, presence) · object storage (images) · search engine · maps/routing · payment gateway · SMS/WhatsApp/push
```

Use npm workspaces when the second app (partner) is created. Don't split into microservices until a specific scaling or ownership need appears.

---

## What NOT to build yet
- Microservices, Kubernetes, multi-region — not until real traffic requires it.
- Grocery/quick-commerce, ads platform, B2B supplies — these come after the food loop has product–market fit.
- Your own maps or routing engine — use a provider.
- A custom payment stack — always use a licensed payment aggregator.

---

## Success metrics per phase
| Phase | North-star metrics |
|---|---|
| 0 | CI green rate, test coverage of domain packages, p95 API latency |
| 1 | Restaurants live on POS, orders/day through KDS, multi-device conflict rate = 0 lost writes |
| 2 | Order completion rate, on-time %, cost per delivery, refund rate, payment success rate |
| 3 | Onboarding time per restaurant, delayed orders auto-resolved % |
| 4 | Search-to-order conversion, repeat rate (D30), verified review share |
| 5 | NPS (customer/merchant/rider), price-parity coverage %, ETA accuracy (±5 min %) |

---

## Immediate next 12 tickets (in order)

1. Add ESLint + Playwright + GitHub Actions CI (F1).
2. ADR 0005: move to Postgres + PostGIS; add migration tool and repository layer (F2).
3. Move the catalog into DB tables; make `cartEngine`/`checkout` read from the repository (F3).
4. Split `/api/webroutes/[...slug]` into domain handlers with validators (F7).
5. Add roles + outlet membership + permission guard helper (F4).
6. Build the order state machine + `order_events` + outbox; delete the simulated stage logic (F5).
7. SSE endpoint `/api/stream` with per-user/per-outlet channels (F6).
8. Rate limiting + phone OTP + password reset (F9).
9. `/partner/orders` inbox (accept/reject/prep time/ready) wired to SSE (P2).
10. Operation-log based multi-terminal POS sync (P3).
11. QR table ordering into POS (P4).
12. Unified KDS showing dine-in + delivery tickets (P5).
