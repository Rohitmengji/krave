import { expect, test } from "@playwright/test";
import { resetBrowser } from "./helpers";

// The outlet-wide 86 list and the demo inbox ran on the retired sample catalog. Owners now take
// a dish off sale from /owner (owner-menu.spec.ts); what is left to prove here is that a
// signed-out browser can never change a menu.
test.describe("Outlet-wide availability", () => {
  test("refuses a signed-out browser the power to change a menu", async ({ page }) => {
    await resetBrowser(page);

    const denied = await page.request.post("/api/webroutes/menu/availability", {
      data: { itemId: "ctl_raj_kachori", unavailable: true },
    });
    expect(denied.status()).toBe(401);

    // Reading stays open, because every customer needs an honest menu.
    const read = await page.request.get("/api/webroutes/menu/availability");
    expect(read.status()).toBe(200);
  });
});
