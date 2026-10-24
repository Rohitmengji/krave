import { expect, test } from "@playwright/test";
import { registerAccount, resetBrowser, uniqueEmail } from "./helpers";
import { createRestaurant } from "./restaurants";

const PASSWORD = "e2e-demo-password";

test.describe("Storefront", () => {
  test("lists only published restaurants and opens their real menu", async ({ page }) => {
    await resetBrowser(page);
    const listed = await createRestaurant(page, "Storefront Listed", { publish: true });
    const draft = await createRestaurant(page, "Storefront Draft");

    // A signed-out customer sees what owners have published, and nothing invented.
    await page.request.post("/api/webroutes/auth/logout");
    await page.goto("/", { waitUntil: "networkidle" });
    const directory = page.getByTestId("restaurant-directory");
    await expect(directory.getByRole("link", { name: listed.name })).toBeVisible();
    await expect(directory.getByRole("link", { name: draft.name })).toHaveCount(0);
    await expect(page.getByText(/Restaurants are fictional/)).toHaveCount(0);

    await directory.getByRole("link", { name: listed.name }).click();
    await page.waitForURL(`**/r/${listed.slug}`);
    await expect(page.getByRole("heading", { level: 1, name: listed.name })).toBeVisible();
    await expect(page.getByText("Paneer Tikka").first()).toBeVisible();
  });

  test("filters the list from the search box and says when nothing matches", async ({ page }) => {
    await resetBrowser(page);
    const listed = await createRestaurant(page, "Storefront Searchable", { publish: true });
    await page.goto("/", { waitUntil: "networkidle" });
    const directory = page.getByTestId("restaurant-directory");
    const search = page.getByTestId("universal-search-input");

    await search.fill("  storefront SEARCHABLE ");
    await expect(directory.getByTestId("restaurant-directory-item")).toHaveCount(1);
    await expect(directory.getByRole("link", { name: listed.name })).toBeVisible();

    await search.fill("no restaurant is called this");
    await expect(directory).toContainText("No restaurants match");
    await directory.getByRole("button", { name: "Clear search" }).click();
    await expect(search).toHaveValue("");
    await expect(directory.getByRole("link", { name: listed.name })).toBeVisible();
  });

  test("no longer serves the retired sample restaurants", async ({ request }) => {
    for (const path of ["/restaurant/19677790", "/restaurant/18238278"]) {
      expect((await request.get(path)).status(), path).toBe(404);
    }
  });

  test("opens the inbox and closes it with Escape", async ({ page }) => {
    await resetBrowser(page);

    await page.getByTestId("navbar-inbox").click();
    const inbox = page.getByRole("dialog", { name: "Notifications" });
    await expect(inbox).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(inbox).toBeHidden();
  });
});

test.describe("Accounts", () => {
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
    await page.evaluate(async () =>
      (await caches.open("krave-shell-v2")).put("/pos", new Response("signed-in floor"))
    );

    await page.getByTestId("navbar-account").click();
    await page.getByTestId("account-sign-out").click();
    await expect(page.getByTestId("navbar-account")).toContainText("Sign in");
    // The dialog has closed, so the page's own region speaks.
    await expect(page.locator("#krave-announcer")).toHaveText("Signed out.");
    // The offline terminal listed this account's outlets and menus.
    await expect
      .poll(() => page.evaluate(async () => Boolean(await caches.match("/pos"))))
      .toBe(false);

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
