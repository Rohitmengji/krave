import { expect, test } from "@playwright/test";
import { addDishAndFire, openTable, registerAccount, resetBrowser, uniqueEmail } from "./helpers";
import { createRestaurant, openTerminal } from "./restaurants";

/**
 * The owner gives a waiter's own account the table POS from the workspace, and takes it away
 * again. The waiter signs up first, on their own phone, as a real waiter does.
 */
test("an owner gives a waiter the table POS from the workspace, and takes it back", async ({ page, browser }) => {
  test.slow();
  await resetBrowser(page);
  const restaurant = await createRestaurant(page, `Team Khanawali ${Date.now().toString(36)}`);

  const waiterContext = await browser.newContext();
  try {
    const waiter = await waiterContext.newPage();
    const email = uniqueEmail("waiter");
    await registerAccount(waiter, email, "135792");
    await waiter.goto("/pos", { waitUntil: "networkidle" });
    await expect(waiter.getByTestId("pos-unavailable")).toContainText("No restaurant on this account yet");

    // The owner does this from a phone.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/owner");
    const picker = page.getByLabel("Restaurant", { exact: true });
    // Other specs share this account, so pick this spec's restaurant when there are several.
    if (await picker.isVisible().catch(() => false)) await picker.selectOption({ label: restaurant.name });
    await expect(page.getByRole("heading", { level: 2, name: restaurant.name, exact: true })).toBeVisible();

    const team = page.getByTestId("restaurant-team");
    await expect(team.getByRole("listitem").filter({ hasText: "(you)" })).toContainText("Owner");
    // Typed the way a phone keyboard capitalises it.
    await team.getByLabel("Email of their KRAVE account").fill(` ${email.toUpperCase()} `);
    await team.getByRole("button", { name: "Give access" }).click();
    await expect(team.getByRole("status")).toHaveText("E2E Guest now has Waiter access.");
    const row = team.getByRole("listitem").filter({ hasText: email });
    await expect(row.getByLabel("Role for E2E Guest")).toHaveValue("staff");
    const panel = await team.boundingBox();
    expect(panel && panel.x >= 0 && panel.x + panel.width <= 390, "the team panel fits the phone").toBe(true);

    await waiter.goto("/pos", { waitUntil: "networkidle" });
    await expect(waiter.getByTestId("pos-table-T1")).toBeVisible();
    // A waiter bills; the workspace stays the owner's.
    await waiter.goto("/owner");
    await expect(
      waiter.getByRole("heading", { name: "No restaurant is connected to this account" })
    ).toBeVisible();

    // Removing asks first; "Keep" leaves the waiter alone.
    await row.getByRole("button", { name: "Remove E2E Guest" }).click();
    await row.getByRole("button", { name: "Keep" }).click();
    await row.getByRole("button", { name: "Remove E2E Guest" }).click();
    await row.getByRole("button", { name: "Remove access" }).click();
    await expect(team.getByRole("status")).toHaveText("E2E Guest no longer has access.");
    await expect(team.getByRole("listitem").filter({ hasText: email })).toHaveCount(0);

    await waiter.goto("/pos", { waitUntil: "networkidle" });
    await expect(waiter.getByTestId("pos-unavailable")).toContainText("No restaurant on this account yet");
  } finally {
    await waiterContext.close();
  }
});

test("adding an email nobody has signed up with says so and adds no one", async ({ page }) => {
  await resetBrowser(page);
  const restaurant = await createRestaurant(page, `Team Typo ${Date.now().toString(36)}`);
  await page.goto("/owner");
  const picker = page.getByLabel("Restaurant", { exact: true });
  if (await picker.isVisible().catch(() => false)) await picker.selectOption({ label: restaurant.name });

  const team = page.getByTestId("restaurant-team");
  await team.getByLabel("Email of their KRAVE account").fill(uniqueEmail("not-signed-up"));
  await team.getByLabel("Access", { exact: true }).selectOption("owner");
  await team.getByRole("button", { name: "Give access" }).click();
  await expect(team.getByRole("alert")).toContainText("No KRAVE account uses that email yet");
  await expect(team.getByRole("listitem")).toHaveCount(1);
});

/**
 * The day's takings are the owner's business. A waiter bills tables and can find a bill
 * again to send it, but never sees the restaurant's sales list or its totals.
 */
test("a waiter finds one bill but never the day's takings", async ({ page, browser }) => {
  test.slow();
  await resetBrowser(page);
  const restaurant = await createRestaurant(page, `Team Sales ${Date.now().toString(36)}`);

  // The owner takes a bill of their own first, which is not the waiter's to look up.
  await openTerminal(page, restaurant);
  await openTable(page, "T1");
  await addDishAndFire(page, /Paneer Tikka/);
  await page.getByTestId("pos-settle").click();
  await page.getByTestId("pos-confirm-settle").click();
  await expect(page.getByTestId("pos-receipt-bill-number")).toHaveText("Bill No. 1", { timeout: 20_000 });
  await page.getByTestId("pos-close-receipt").click();

  const waiterContext = await browser.newContext();
  try {
    const waiter = await waiterContext.newPage();
    const email = uniqueEmail("waiter-sales");
    await registerAccount(waiter, email, "135792");

    await page.goto("/owner");
    const picker = page.getByLabel("Restaurant", { exact: true });
    if (await picker.isVisible().catch(() => false)) await picker.selectOption({ label: restaurant.name });
    const team = page.getByTestId("restaurant-team");
    await team.getByLabel("Email of their KRAVE account").fill(email);
    await team.getByRole("button", { name: "Give access" }).click();
    await expect(team.getByRole("status")).toContainText("Waiter access");

    await waiter.goto("/pos", { waitUntil: "networkidle" });
    await waiter.getByLabel("Outlet").selectOption({ label: restaurant.name });
    // No takings on the header: a waiter gets a lookup instead.
    await expect(waiter.getByTestId("pos-open-sales")).toHaveText("Find a bill");
    await expect(waiter.getByTestId("pos-open-settled-history")).toHaveCount(0);

    await openTable(waiter, "T4");
    await addDishAndFire(waiter, /Chicken Kari \(Full\)/);
    await waiter.getByTestId("pos-settle").click();
    await waiter.getByTestId("pos-confirm-settle").click();
    await expect(waiter.getByTestId("pos-receipt-bill-number")).toHaveText("Bill No. 2", { timeout: 20_000 });
    await waiter.getByTestId("pos-close-receipt").click();

    await waiter.getByTestId("pos-open-sales").click();
    const find = waiter.getByRole("dialog", { name: "Find a bill" });
    await expect(find.getByTestId("sales-empty")).toContainText("bill number");
    await expect(find.getByTestId("sales-summary")).toHaveCount(0);
    await expect(find.getByTestId("sales-entry")).toHaveCount(0);

    // The owner's bill cannot be read by guessing its number; the waiter's own opens.
    await find.getByTestId("sales-search").fill("1");
    await expect(find.getByTestId("sales-entry")).toHaveCount(0);
    await find.getByTestId("sales-search").fill("2");
    await expect(find.getByTestId("sales-entry")).toHaveCount(1);
    await expect(find.getByTestId("sales-summary")).toHaveCount(0);
    await find.getByTestId("sales-entry").click();
    await expect(waiter.getByRole("dialog", { name: "Past bill" })).toContainText("Chicken Kari");
  } finally {
    await waiterContext.close();
  }
});
