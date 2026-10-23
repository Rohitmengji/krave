import { expect, type Page } from "@playwright/test";

/** A fresh device: no cached shell, no carried-over local state, no session. */
export async function resetBrowser(page: Page, path = "/") {
  await page.goto(path);
  await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    localStorage.clear();
  });
  await page.request.post("/api/webroutes/auth/logout");
  await page.goto(path, { waitUntil: "networkidle" });
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@krave.test`;
}

export async function registerAccount(page: Page, email: string, password: string) {
  const response = await page.request.post("/api/webroutes/auth/register", {
    data: { email, password, displayName: "E2E Guest" },
  });
  expect(response.status()).toBe(201);
}

/** Matches KRAVE_STAFF_EMAILS in playwright.config.ts. */
export const STAFF_EMAIL = "e2e-staff@krave.test";
export const STAFF_PASSWORD = "e2e-staff-password";

/**
 * Signs in as the one account the server treats as staff.
 *
 * The suite runs against a shared database, so this registers on first use and
 * signs in afterwards rather than assuming either.
 */
export async function signInAsStaff(page: Page) {
  // Sign in first: every register call spends the per-client signup quota, even when it
  // fails because the account exists, and the suite would exhaust it after ~30 calls.
  const signedIn = await page.request.post("/api/webroutes/auth/login", {
    data: { email: STAFF_EMAIL, password: STAFF_PASSWORD },
  });
  if (signedIn.ok()) return;

  const created = await page.request.post("/api/webroutes/auth/register", {
    data: { email: STAFF_EMAIL, password: STAFF_PASSWORD, displayName: "E2E Staff" },
  });
  expect(created.status(), await created.text()).toBe(201);
}

/** Adds the first dish of the first restaurant, handling the customisation step. */
export async function addFirstDishToCart(page: Page) {
  await page.getByRole("button", { name: "Order Menu" }).first().click();
  // Scoped to the menu dialog: an unscoped "ADD" also matches controls elsewhere on the page.
  const menu = page.getByTestId("restaurant-detail-modal");
  await menu.getByRole("button", { name: "ADD" }).first().click();
  await page.getByRole("button", { name: /Add Item to Cart/ }).click();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("floating-cart-bar")).toBeVisible();
}

export async function placeDemoOrder(page: Page) {
  await page.getByTestId("floating-cart-bar").click();
  await page.getByTestId("place-order-zpaykit-btn").click();
  // Success opens tracking over the page, which would swallow any following click.
  const tracking = page.getByTestId("crystal-tracking-modal");
  await expect(tracking).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(tracking).toBeHidden();
  await expect(page.getByTestId("order-history-entry").first()).toBeVisible();
}

export async function openTable(page: Page, tableId: string) {
  await page.getByTestId(`pos-table-${tableId}`).click();
  await page.getByTestId("pos-confirm-open-table").click();
  await expect(page.getByRole("region", { name: `Table ${tableId}` })).toBeVisible();
}

export async function addDishAndFire(page: Page, dishName: RegExp) {
  await page.getByRole("button", { name: dishName }).click();
  await page.getByTestId("pos-send-kitchen").click();
  await expect(page.getByRole("dialog", { name: "Kitchen ticket" })).toBeVisible();
  await page.getByTestId("pos-close-kot").click();
}
