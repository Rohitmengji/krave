import { expect, test } from "@playwright/test";
import { addDishAndFire, openTable, registerAccount, resetBrowser, uniqueEmail } from "./helpers";
import { createRestaurant, openTerminal } from "./restaurants";

const PASSWORD = "e2e-demo-password";
const PANEER = /Paneer Tikka/;

/** Settle a table on the counter and return the claim code printed on its receipt. */
async function settleTableAndReadCode(page: import("@playwright/test").Page, tableId: string) {
  await openTable(page, tableId);
  await addDishAndFire(page, PANEER);
  await page.getByTestId("pos-settle").click();
  await page.getByTestId("pos-confirm-settle").click();

  const code = page.getByTestId("pos-receipt-claim-code");
  await expect(code).toBeVisible({ timeout: 20_000 });
  const value = (await code.innerText()).trim();
  await page.getByTestId("pos-close-receipt").click();
  return value;
}

test.describe("Dine-in bill claiming", () => {
  test("refuses claiming to a signed-out browser", async ({ page }) => {
    await resetBrowser(page);
    const denied = await page.request.post("/api/webroutes/account/claim-bill", {
      data: { code: "ABCDEFGHJK" },
    });
    expect(denied.status()).toBe(401);
  });

  test("carries a table bill onto the guest's own account", async ({ page, browser }) => {
    // The counter settles a table. It never learns who the guest is.
    await resetBrowser(page);
    const restaurant = await createRestaurant(page, "Claim Counter");
    await openTerminal(page, restaurant);
    const code = await settleTableAndReadCode(page, "T1");
    expect(code).toMatch(/^[2345679BCDFGHJKLMNPQRSTVWXYZ]{10}$/);

    // A separate guest, on their own device, claims it from the receipt.
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    await guest.goto("/");
    await registerAccount(guest, uniqueEmail("diner"), PASSWORD);
    await guest.reload({ waitUntil: "networkidle" });

    await guest.getByTestId("claim-bill-code").fill(code.toLowerCase());
    await guest.getByTestId("claim-bill-submit").click();

    await expect(guest.getByTestId("dine-in-bill-entry")).toHaveCount(1);
    await expect(guest.getByTestId("dine-in-bill-entry").first()).toContainText("₹252");
    await expect(guest.getByTestId("dine-in-bill-entry").first()).toContainText(restaurant.name);

    // It survives a wipe, because it lives on the account rather than the device.
    await guest.evaluate(() => localStorage.clear());
    await guest.reload({ waitUntil: "networkidle" });
    await expect(guest.getByTestId("dine-in-bill-entry")).toHaveCount(1);

    await guestContext.close();
  });

  test("lets only the first holder claim a bill", async ({ page, browser }) => {
    await resetBrowser(page);
    const restaurant = await createRestaurant(page, "Claim Counter Two");
    await openTerminal(page, restaurant);
    const code = await settleTableAndReadCode(page, "T2");

    const firstContext = await browser.newContext();
    const first = await firstContext.newPage();
    await first.goto("/");
    await registerAccount(first, uniqueEmail("first"), PASSWORD);
    expect(
      (await first.request.post("/api/webroutes/account/claim-bill", { data: { code } })).status()
    ).toBe(200);

    const secondContext = await browser.newContext();
    const second = await secondContext.newPage();
    await second.goto("/");
    await registerAccount(second, uniqueEmail("second"), PASSWORD);
    const stolen = await second.request.post("/api/webroutes/account/claim-bill", {
      data: { code },
    });
    expect(stolen.status()).toBe(400);
    expect((await stolen.json()).message).toMatch(/not valid or has already been used/i);

    const secondAccount = await (await second.request.get("/api/webroutes/account/me")).json();
    expect(secondAccount.dineInBills).toHaveLength(0);

    await firstContext.close();
    await secondContext.close();
  });

  test("answers identically for an unknown code", async ({ page }) => {
    await resetBrowser(page);
    await registerAccount(page, uniqueEmail("prober"), PASSWORD);

    const unknown = await page.request.post("/api/webroutes/account/claim-bill", {
      data: { code: "ZZZZZZZZZZ" },
    });
    const malformed = await page.request.post("/api/webroutes/account/claim-bill", {
      data: { code: "nope" },
    });

    expect(unknown.status()).toBe(malformed.status());
    expect((await unknown.json()).message).toBe((await malformed.json()).message);
  });
});
