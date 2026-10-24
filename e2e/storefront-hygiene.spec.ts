import { expect, test } from "@playwright/test";
import { registerAccount, resetBrowser, uniqueEmail } from "./helpers";

// Behaviours that only exist in a real browser: focus movement, lazy-chunk mounting,
// response headers and routing. The unit suite covers the logic behind each one.
test.describe("Storefront hygiene", () => {
  test("the required sign-in dialog keeps typed input and does not close on Escape", async ({ page }) => {
    await resetBrowser(page);
    const dialog = page.locator("dialog[open]");

    await expect(dialog).toBeVisible();
    await dialog.getByLabel(/email/i).first().fill("draft@krave.test");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
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

    // The required sign-in dialog fetches its chunk; that must pass the policy too.
    await expect(page.locator("dialog[open]")).toBeVisible();
    expect(violations).toEqual([]);
  });

  test("a toast raised inside a modal is seen above it and heard from within it", async ({ page }) => {
    await resetBrowser(page);
    await registerAccount(page, uniqueEmail("studio"), "135790");
    await page.goto("/", { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /Brand Studio|Customize Branding/ }).first().click();
    const studio = page.getByTestId("brand-studio-modal");
    await studio.getByRole("button", { name: /Aurum Saffron/ }).click();

    // Seen: the visual toast is a top-layer popover shown after the dialog, so it paints above.
    const toast = page.locator("[popover]").filter({ hasText: "Applied Aurum Saffron Reserve theme" });
    await expect(toast).toBeVisible();
    expect(await toast.evaluate((element) => element.matches(":popover-open"))).toBe(true);

    // Heard: everything outside an open modal is inert, so the announcement must come from
    // a live region inside the topmost dialog, not from the toast.
    await expect(studio.getByRole("status")).toHaveText("Applied Aurum Saffron Reserve theme");
    await expect(toast).toHaveAttribute("aria-hidden", "true");

    await page.keyboard.press("Escape");
    await expect(studio).toBeHidden();
  });

  test("reloads the storefront offline from the service worker", async ({ page, context }) => {
    await resetBrowser(page);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    // The first load happened before the worker controlled the page; this one is cached by it.
    await page.reload({ waitUntil: "networkidle" });

    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.getByRole("heading", { name: "Restaurants on KRAVE" })).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });
});
