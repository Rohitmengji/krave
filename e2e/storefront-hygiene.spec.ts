import { expect, test } from "@playwright/test";
import { addFirstDishToCart, placeDemoOrder, resetBrowser } from "./helpers";

// Behaviours that only exist in a real browser: focus movement, lazy-chunk mounting,
// response headers and routing. The unit suite covers the logic behind each one.
test.describe("Storefront hygiene", () => {
  test("returns focus to Track Order after checkout's tracking view closes", async ({ page }) => {
    await resetBrowser(page);
    await addFirstDishToCart(page);
    // The opener (the drawer's pay button) is gone by the time tracking closes.
    await placeDemoOrder(page);
    await expect(page.getByRole("button", { name: /Track Order/ }).first()).toBeFocused();
  });

  test("a lazily loaded dialog keeps typed input across close and reopen", async ({ page }) => {
    await resetBrowser(page);
    const signIn = page.getByRole("button", { name: /Sign in/ }).first();
    const dialog = page.locator("dialog[open]");

    await signIn.click();
    await dialog.getByLabel(/email/i).first().fill("draft@krave.test");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(signIn).toBeFocused();

    await signIn.click();
    await expect(dialog.getByLabel(/email/i).first()).toHaveValue("draft@krave.test");
  });

  test("serves the security headers and loads without a CSP violation", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
    });
    const response = await page.goto("/", { waitUntil: "networkidle" });
    const headers = response!.headers();
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain("object-src 'none'");
    expect(headers["strict-transport-security"]).toContain("max-age=");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["x-content-type-options"]).toBe("nosniff");

    // Opening a dialog fetches its chunk and images; those must pass the policy too.
    await page.getByRole("button", { name: "Order Menu" }).first().click();
    await expect(page.getByTestId("restaurant-detail-modal")).toBeVisible();
    expect(violations).toEqual([]);
  });

  test("restaurant pages answer on one canonical URL only", async ({ request }) => {
    const canonical = await request.get("/restaurant/19677790");
    expect(canonical.status()).toBe(200);
    for (const alias of ["019677790", "19677790.0", "1.967779e7", "0x12c425e"]) {
      const response = await request.get(`/restaurant/${alias}`);
      expect(response.status(), alias).toBe(404);
    }
  });
});
