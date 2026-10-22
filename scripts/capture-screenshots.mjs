/**
 * Captures the screens behind recent roadmap work into docs/screenshots/.
 *
 * Run against an already-built app:
 *   KRAVE_QUOTE_SECRET=local npx next start --port 3030
 *   node scripts/capture-screenshots.mjs
 */
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.KRAVE_SHOT_URL || "http://127.0.0.1:3030";
const OUT = path.join(process.cwd(), "docs", "screenshots");

const shots = [];

async function shot(page, name, description, locator) {
  const file = path.join(OUT, `${name}.png`);
  await (locator ?? page).screenshot({ path: file });
  shots.push({ name, description });
  console.log(`  captured ${name}.png — ${description}`);
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  console.log(`Capturing from ${BASE}`);
  await page.goto(BASE, { waitUntil: "networkidle" });

  await shot(
    page,
    "01-listing-fees",
    "Fees stated on every listing card, not first revealed at checkout",
    page.locator("article").first()
  );

  // Menu: portions and allergen declarations.
  await page.getByTestId("open-menu-19677790").click();
  const menu = page.getByTestId("restaurant-detail-modal");
  await menu.waitFor();
  await shot(page, "02-menu-portions-allergens", "Declared portion, price per 100g, and allergen state per dish");

  await menu.getByTestId("allergen-TREE_NUT").click();
  await page.waitForTimeout(250);
  await shot(
    page,
    "03-allergen-filter",
    "Avoiding tree nuts: undeclared dishes shown separately, never as safe"
  );

  await menu.getByTestId("allergen-clear").click();

  // Cart: price lock and the bill.
  await menu.getByRole("button", { name: "ADD" }).first().click();
  await page.getByRole("button", { name: /Add Item to Cart/ }).click();
  await page.keyboard.press("Escape");
  await page.getByTestId("floating-cart-bar").click();

  // The bill sits below the fold, so scroll it in or the shot proves nothing.
  const lockNote = page.getByTestId("cart-lock-note");
  await lockNote.waitFor();
  await lockNote.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await shot(page, "04-price-lock-bill", "Itemised bill with the 10-minute price lock stated");

  // Cart with an allergy declared: per-line declarations appear.
  await page.getByTestId("kitchen-flag-ALLERGY").scrollIntoViewIfNeeded();
  await page.getByTestId("kitchen-flag-ALLERGY").click();
  await page.getByTestId("allergy-note").fill("severe peanut allergy");
  await page.waitForTimeout(300);
  await page.getByTestId("allergy-note").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page, "05-cart-allergy-declared", "Allergy declared: each line shows what the kitchen declared");

  await page.keyboard.press("Escape");

  // Refund claim: needs a signed-in account with a delivered order.
  const email = `shots-${Date.now()}@krave.test`;
  await page.request.post(`${BASE}/api/webroutes/auth/register`, {
    data: { email, password: "screenshot-password", displayName: "Screenshot Guest" },
  });
  await page.reload({ waitUntil: "networkidle" });

  await page.getByTestId("floating-cart-bar").click();
  await page.getByTestId("place-order-zpaykit-btn").click();
  await page.getByTestId("crystal-tracking-modal").waitFor({ timeout: 15000 });
  await page.keyboard.press("Escape");

  const me = await (await page.request.get(`${BASE}/api/webroutes/account/me`)).json();
  const orderId = me.orders?.[0]?.orderId;
  if (orderId) {
    for (const stage of ["KITCHEN_PREPARING", "RIDER_ASSIGNED", "OUT_FOR_DELIVERY", "ARRIVED"]) {
      await page.request.post(`${BASE}/api/webroutes/order/stage`, { data: { orderId, stage } });
    }
    page.once("dialog", (dialog) => dialog.accept());
    await page.reload({ waitUntil: "networkidle" });
    const report = page.getByTestId(`report-issue-${orderId}`);
    await report.scrollIntoViewIfNeeded();
    await report.click();
    await page.getByTestId(`dispute-status-${orderId}`).waitFor({ timeout: 10000 });
    await page.getByTestId(`dispute-status-${orderId}`).scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await shot(
      page,
      "06-refund-claim",
      "Refund claim decided server-side: outcome and reason shown on the order"
    );
  }

  // Counter view.
  await page.goto(`${BASE}/pos`, { waitUntil: "networkidle" });
  await shot(page, "07-pos-terminal", "Dine-in terminal with the delivery ticket rail");

  await browser.close();

  console.log(`\n${shots.length} screenshots in docs/screenshots/`);
}

main().catch((error) => {
  console.error("Capture failed:", error.message);
  process.exitCode = 1;
});
