import { expect, test } from "@playwright/test";
import {
  addFirstDishToCart,
  placeDemoOrder,
  registerAccount,
  resetBrowser,
  uniqueEmail,
} from "./helpers";

const PASSWORD = "e2e-demo-password";

test.describe("Storefront", () => {
  test("browses, adds a dish, and places a demo order", async ({ page }) => {
    await resetBrowser(page);
    await addFirstDishToCart(page);
    await placeDemoOrder(page);

    await expect(page.getByTestId("order-history-entry")).toHaveCount(1);
    await expect(page.getByTestId("order-history-entry").first()).toContainText("ORDER CONFIRMED");
  });

  test("keeps the cart across a refresh without storing prices", async ({ page }) => {
    await resetBrowser(page);
    await addFirstDishToCart(page);
    const before = await page.getByTestId("floating-cart-bar").innerText();

    const saved = await page.evaluate(() => localStorage.getItem("krave.session.v1"));
    expect(saved).not.toContain("unitPrice");

    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByTestId("floating-cart-bar")).toBeVisible();
    expect(await page.getByTestId("floating-cart-bar").innerText()).toBe(before);
  });

  test("never presents an undeclared dish as free of an allergen", async ({ page }) => {
    await resetBrowser(page);
    await page.getByRole("button", { name: "Order Menu" }).first().click();
    const menu = page.getByTestId("restaurant-detail-modal");

    // Before any filter is applied, nothing claims to be allergen-free.
    await expect(menu.getByTestId("allergen-caveat")).toBeHidden();

    await menu.getByTestId("allergen-TREE_NUT").click();
    await expect(menu.getByTestId("allergen-caveat")).toBeVisible();

    // Declared-contains dishes are called out, not silently hidden.
    await expect(menu.getByText("Contains Tree nuts").first()).toBeVisible();

    // The property that matters: dishes with no declaration say so rather than
    // appearing alongside genuinely cleared dishes.
    const undeclared = menu.getByText("Allergens not declared — ask the restaurant");
    expect(await undeclared.count()).toBeGreaterThan(0);
    await expect(undeclared.first()).toBeVisible();
  });

  test("holds the quoted price and says so before payment", async ({ page }) => {
    await resetBrowser(page);
    await addFirstDishToCart(page);
    await page.getByTestId("floating-cart-bar").click();

    const total = await page.getByTestId("cart-grand-total").innerText();
    await expect(page.getByTestId("cart-lock-note")).toBeVisible();

    await page.getByTestId("place-order-zpaykit-btn").click();
    await expect(page.getByTestId("crystal-tracking-modal")).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press("Escape");

    // The charged amount must match what the drawer promised, not a recomputed surprise.
    await expect(page.getByTestId("order-history-entry").first()).toContainText(
      total.replace(/\s/g, "")
    );
  });

  test("cancels only while the order is still confirmed", async ({ page }) => {
    await resetBrowser(page);
    await addFirstDishToCart(page);
    await placeDemoOrder(page);

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("cancel-order").click();
    await expect(page.getByTestId("order-history-entry")).toHaveCount(0);
  });

  test("opens offers and the inbox, and closes both with Escape", async ({ page }) => {
    await resetBrowser(page);

    await page.getByTestId("navbar-offers").click();
    const offers = page.getByRole("dialog", { name: "Coupons and partner offers" });
    await expect(offers).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(offers).toBeHidden();

    await page.getByTestId("navbar-inbox").click();
    const inbox = page.getByRole("dialog", { name: "Notifications" });
    await expect(inbox).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(inbox).toBeHidden();
  });

  test("records a notification when an order is placed", async ({ page }) => {
    await resetBrowser(page);
    await addFirstDishToCart(page);
    await placeDemoOrder(page);

    await expect(page.getByTestId("inbox-unread-badge")).toHaveText("1");
    await page.getByTestId("navbar-inbox").click();
    await expect(page.getByTestId("notification-entry").first()).toContainText("Demo order confirmed");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("inbox-unread-badge")).toHaveCount(0);
  });

  test("keeps the cart and order history in step across open tabs", async ({ page, context }) => {
    await resetBrowser(page);
    const other = await context.newPage();
    await other.goto("/", { waitUntil: "networkidle" });
    await expect(other.getByTestId("floating-cart-bar")).toHaveCount(0);

    // No reload: the second tab hears about each change from the storage event.
    await addFirstDishToCart(page);
    await expect(other.getByTestId("floating-cart-bar")).toBeVisible();

    await placeDemoOrder(page);
    await expect(other.getByTestId("floating-cart-bar")).toHaveCount(0);
    await expect(other.getByTestId("order-history-entry")).toHaveCount(1);
    await expect(other.getByTestId("inbox-unread-badge")).toHaveText("1");
    await other.close();
  });

  test("serves a shareable restaurant page and 404s an unknown one", async ({ page }) => {
    await resetBrowser(page);

    await page.goto("/restaurant/19677790", { waitUntil: "networkidle" });
    await expect(page).toHaveTitle(/Mithaas/);
    await expect(page.getByRole("dialog").first()).toBeVisible();

    const missing = await page.goto("/restaurant/999999");
    expect(missing?.status()).toBe(404);
  });
});

test.describe("Accounts", () => {
  test("keeps an order after local storage is wiped", async ({ page }) => {
    const email = uniqueEmail("durable");
    await resetBrowser(page);
    await registerAccount(page, email, PASSWORD);
    await page.reload({ waitUntil: "networkidle" });

    await addFirstDishToCart(page);
    await placeDemoOrder(page);
    await expect(page.getByTestId("order-history-entry")).toHaveCount(1);

    // Only a server-backed history can survive this.
    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle" });

    await expect(page.getByTestId("order-history-entry")).toHaveCount(1);
    const localCopy = await page.evaluate(() => localStorage.getItem("krave.demo-orders.v1"));
    expect(localCopy).toBeNull();
  });

  test("refuses a refund claim from a browser that is not signed in", async ({ page }) => {
    await resetBrowser(page);
    const response = await page.request.post("/api/webroutes/account/dispute", {
      data: { orderId: "ord_anything", reason: "MISSING_ITEM", lines: [{ itemId: "x", quantity: 1 }] },
    });
    expect(response.status()).toBe(401);
  });

  test("refuses a refund claim for an order the account does not own", async ({ page }) => {
    const email = uniqueEmail("claimant");
    await resetBrowser(page);
    await registerAccount(page, email, PASSWORD);
    await page.reload({ waitUntil: "networkidle" });

    const response = await page.request.post("/api/webroutes/account/dispute", {
      data: {
        orderId: "ord_not_mine",
        reason: "MISSING_ITEM",
        lines: [{ itemId: "ctl_820099425", quantity: 1 }],
      },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).message).toMatch(/not in your history/i);
  });

  test("signs in and out through the dialog", async ({ page }) => {
    const email = uniqueEmail("session");
    await resetBrowser(page);
    await registerAccount(page, email, PASSWORD);
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByTestId("navbar-account")).toContainText("E2E Guest");

    await page.getByTestId("navbar-account").click();
    await page.getByTestId("account-sign-out").click();
    await expect(page.getByTestId("navbar-account")).toContainText("Sign in");

    await page.getByTestId("navbar-account").click();
    await page.getByLabel("Email").fill(email);
    await page.getByLabel(/Password/).fill(PASSWORD);
    await page.getByTestId("account-submit").click();
    await expect(page.getByTestId("navbar-account")).toContainText("E2E Guest");
  });

  test("never leaves the session cookie readable by page scripts", async ({ page }) => {
    await resetBrowser(page);
    await registerAccount(page, uniqueEmail("cookie"), PASSWORD);
    await page.reload({ waitUntil: "networkidle" });

    expect(await page.evaluate(() => document.cookie)).not.toContain("krave_session");
  });
});
