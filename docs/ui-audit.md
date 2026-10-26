# KRAVE interface audit — 25 October 2026

Every screen was walked at phone size (390×844, the width of Rohit's phone) and checked with
axe (WCAG 2.0/2.1 A and AA) in `e2e/ui-accessibility.spec.ts`, which now runs with the suite
so none of this can quietly come back.

Status key: **fixed** — changed in this pass; **kept** — deliberate, with the reason.

## 1. Accessibility (axe, serious)

| # | Finding | Where | Status |
|---|---|---|---|
| 1 | Veg/non-veg/egg mark carried `aria-label` on a plain `span`, which ARIA forbids, so screen readers dropped it | menu grid, bill lines, split, sales | **fixed** — `role="img"` with the label "Veg", "Non-veg" or "Egg" (was the raw value `non-veg`) |
| 2 | A dish button was announced "Chicken Kari (Full), ₹120" while it read "Full ₹120" on screen: voice control could not activate what it saw | menu grid | **fixed** — the name now comes from the content, with the dish and portion in screen-reader-only text |
| 3 | The count badge "×2" was not spoken at all | menu grid | **fixed** — "…, 2 on this table" |
| 4 | White on `emerald-500` = 2.47:1 (AA needs 4.5) | Open Table, Settle, Confirm Payment, Open/Close Shift, custom dish, split Done, waiter Save | **fixed** — black text on the bright green, which also reads better in sunlight |
| 5 | White on `emerald-600` = 3.65:1 | owner workspace (Publish, Save dish, Set PIN, Add dish, import, Team, orders filter), Toast, split guest card, error page | **fixed** — `emerald-700` (5.5:1) with a lighter hover |
| 6 | `text-slate-500` hints = 3.76–3.93:1 on dark, 4.36:1 on the public menu | owner workspace empty states, `/r/<slug>` allergen note, checkout, order status | **fixed** — `slate-400` on dark, `slate-600` on light |
| 7 | "KOT #1" at 4.11:1, dimmed by `opacity-60` on its parent | bill lines | **fixed** — `text-white/70` on the row, full-strength KOT text |

Result: 0 violations on the sign-in dialog, the terminal (floor, seat, table, bill, settle,
receipt, sales), the owner workspace, the public menu and the account page.

## 2. Touch targets and typing (phone)

Measured every control in the viewport; anything under 44×44 px is a mis-tap waiting to happen
on a wet hand in a busy room.

| # | Finding | Status |
|---|---|---|
| 8 | Quantity −/+ were 28×20 px — the most-pressed buttons in the app | **fixed** — 44×44 each, larger glyphs |
| 9 | Remove/Void 72×23, Reprint, "Kitchen tickets"/"Voided items" summaries | **fixed** — all `min-h-11` |
| 10 | Header chips (Bills today, Sales today, Open/Close Shift, Storefront, outlet select) 31–34 px tall | **fixed** — `min-h-11` |
| 11 | Menu category chips and "Custom / Off-Menu Dish" 34 px | **fixed** — `min-h-11` |
| 12 | Move-table and Merge selects 24 px tall with 10 px text | **fixed** — `min-h-11`, 16 px text on phones |
| 13 | Cooking-note field 25 px tall with 10 px text, placeholder longer than the box | **fixed** — `min-h-11`, 16 px, shorter placeholder "Note: less spicy, Jain, no onion" |
| 14 | Guests, Discount %, Service %, cash fields 27–31 px, and typing in them zoomed iOS Safari in (any field under 16 px does) | **fixed** — `min-h-11`, 16 px on phones, number fields select their value on focus so a correction is one tap |
| 15 | Dialog close ✕ was 24×24 | **fixed** — 44×44 |
| 16 | Split-bill rows put a 207 px select next to the dish on a 390 px screen | **fixed** — stacked on phones, full-height select |
| 17 | Three-up Split / Send / Settle buttons are 103 px wide, below 44 px only in height | **fixed** — `min-h-11`; they stay three-up because losing the row would cost a scroll |

## 3. Dialog behaviour

| # | Finding | Status |
|---|---|---|
| 18 | All eight terminal dialogs (Seat guests, Void, Settle, Kitchen ticket, Bill, Split, Shift, Z-report) and the owner-PIN dialog were plain `div role="dialog"`: Tab reached the page behind them, Escape did nothing, and a background tap could not close them | **fixed** — all built on `OverlayDialog` (native `<dialog>` + `showModal()`): focus is trapped, Escape closes the top layer only, focus returns to the button that opened it |
| 19 | The owner-PIN dialog could be dismissed while the PIN was being checked, so the answer would have landed on a bill nobody was looking at | **fixed** — it holds until the check finishes |
| 20 | Seat guests, Settle, Split and Shift close on a stray background tap, losing typing | **fixed** — these keep their contents; the ✕ and Cancel still close |
| 21 | Printing: the bill, kitchen ticket and Z-report still print alone (`pos-receipt` / `pos-no-print`), now from inside a native dialog | verified |

## 4. Wording and flow

| # | Finding | Status |
|---|---|---|
| 22 | "Print Bill" is now also how a bill is sent | **fixed** — "Send / Print" |
| 23 | The bill asked for a mobile behind an "Add a mobile number to text this bill" button, then opened a two-field editor | **fixed** — the number field is on the bill; type it and WhatsApp/SMS appear. The number is kept on the table for a resend |
| 24 | WhatsApp buttons were announced "WhatsApp: SMS ₹260" | **fixed** — "WhatsApp ₹260" |
| 25 | The waiter's name defaulted to "Front Desk" even when signed in | **fixed** — defaults to the signed-in account's name, still editable |
| 26 | Email appeared even where the server cannot send it, failing only after an address was typed | **fixed** — the button appears only when the deployment has SMTP; production has it |
| 27 | Dietary marks spoke the raw tag `non-veg` | **fixed** — "Non-veg" |

## 5. Sending a bill (new)

- **WhatsApp / SMS** open the app with the message and a link to the PDF already typed; the
  waiter taps Send. One tap more than fully automatic, and it costs nothing.
- **Email** goes straight from the server with the PDF attached — no second app.
- **PDF bill** opens `/b/<token>`: a one-page A5 receipt, no login, `no-store`, not indexed,
  and 404 for a made-up token. The token is random (22 characters), one per table.
- Fully automatic WhatsApp needs a Meta WhatsApp Business account (business verification, an
  approved template, paid per message); automatic SMS in India needs DLT registration. Both
  can be wired in later without changing this screen.

## 6. Who sees what (new)

| Role | Floor | Their own bills | The restaurant's sales list and totals |
|---|---|---|---|
| Owner / Manager | yes | yes | yes |
| Waiter | yes | yes | **no** — "Find a bill" instead |

- A waiter's phone is no longer sent other people's paid bills at all, so there is nothing to
  read out of the device either.
- A waiter can reprint or resend a bill they took by typing its number, or **any** bill when
  the guest gives the mobile number it was sent to. Bill numbers run 1, 2, 3, so a waiter
  cannot walk through the day's takings by guessing them.
- The header shows no day total to a waiter.

## 7. Two bugs found while testing this (fixed)

| # | Bug | What it would have done at the restaurant |
|---|---|---|
| 28 | A tap was applied to the copy of the table the screen was holding, then written back over whatever had arrived since. A floor update from another phone landing between the render and the tap was silently undone | Items added on a second phone could disappear a moment later. Now adding, removing, changing quantity, notes, discount, guests and voids apply to the table as it stands. Settling, firing a kitchen ticket, merging, moving and owner corrections deliberately keep the old behaviour: if another phone changed the table at that instant, the save is refused and the waiter is told, rather than printing a receipt or ticket that differs from what was stored |
| 29 | After a reload, a terminal had no record of which save the server had confirmed, so a save whose answer never arrived (weak signal) looked newer than the taps that followed it: the server's older, emptier copy replaced them, and the empty table was then saved over the good one | A waiter who reopened the app after a dropped connection could find a table back to empty, with the items lost for good. Now the device keeps what it last agreed with the server, and items it still holds are never dropped for a copy that lacks them — a real clash still comes back as the usual "changed on another phone" message |

Both are covered by tests: the reload case in `src/tests/floorSync.test.ts` and the whole flow in `e2e/terminal.spec.ts`.

## 7a. Added on 26 October

| # | Change | Why |
|---|---|---|
| 30 | **FSSAI licence and GSTIN on every bill** (screen, printout, PDF). The owner enters them once under Restaurant details; spaces are ignored, typos are refused (14-digit FSSAI, 15-character GSTIN) | FSSAI expects the licence number on bills. With a GSTIN on record, a bill that charges GST no longer says "Not a GST tax invoice" |
| 31 | **The public menu link names the restaurant.** The tab title and the WhatsApp/Google preview read "Jagadamba Maratha Khanawali — Menu and prices" instead of the generic KRAVE title | A menu link shared with customers should say whose menu it is |
| 32 | Service-mode checkboxes in Restaurant details enlarged to a 44 px row | They were 13 px squares on a phone |

The public menu and home page were also measured on the live site at phone width: no control under 44 px, no sideways scrolling.

## 8. Known gaps (not fixed, with the reason)

| Gap | Why it is left, and the plan |
|---|---|
| Two waiters can seat the same table at the same moment; the second sees the first's bill | The floor syncs within seconds and the table shows whose bill it is. Preventing it needs a server-side claim on opening — worth doing after live use shows how often it happens |
| A waiter removed from the team keeps a stale copy of the floor on their phone until it reloads | Their next save is refused, so nothing they do reaches the restaurant |
| A phone that was already signed in as a waiter before this change may still hold older bills in its own storage | Clearing the site data on that phone, or using a fresh phone, removes them; nothing new is sent |
| Shifts and the Z-report are per phone, not per restaurant | Matches how the drawer actually works at Jagadamba (one till, one phone). A restaurant-wide shift is a bigger change |
| `npm audit --omit=dev`: 4 high advisories, all from `zod <4.6.6` reached through `@vercel/functions` → `@vercel/oidc` / `@vercel/cli-config` | Not reachable from KRAVE's own code paths; the only fix offered is a major downgrade of `@vercel/functions`. Revisit when Vercel ships a release that pulls zod ≥ 4.6.6 |
| Discounts need no approval | A waiter can discount a bill; it is recorded on the bill and in sales. An owner PIN on discounts is the obvious next guard if the day's takings look wrong |
