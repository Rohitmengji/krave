import { expect, test } from "@playwright/test";
import { registerAccount, resetBrowser, uniqueEmail } from "./helpers";
import { createRestaurant } from "./restaurants";

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
