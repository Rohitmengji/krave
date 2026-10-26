import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { addDishAndFire, resetBrowser, signInAsStaff } from "./helpers";
import { createRestaurant, openTerminal } from "./restaurants";

/**
 * Automated accessibility checks (axe, WCAG 2.1 A and AA) on every screen staff and guests
 * use, at phone size because that is where the restaurant uses them.
 */
test.use({ viewport: { width: 390, height: 844 } });

const WCAG = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

async function violations(page: Page, label: string) {
  const { violations: found } = await new AxeBuilder({ page }).withTags(WCAG).analyze();
  const summary = found.map((violation) => ({
    rule: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.slice(0, 12).map((node) => {
      const data = node.any[0]?.data as { fgColor?: string; bgColor?: string; contrastRatio?: number } | undefined;
      const colors = data?.contrastRatio ? ` [${data.fgColor} on ${data.bgColor} = ${data.contrastRatio}]` : "";
      return `${node.target.join(" ")}${colors} :: ${node.html.slice(0, 120)}`;
    }),
  }));
  if (summary.length > 0) console.info(`AXE ${label}: ${JSON.stringify(summary, null, 1)}`);
  return summary;
}

const freshName = (label: string) => `Axe ${label} ${Date.now().toString(36)}`;

test("the sign-in and create-account dialog", async ({ page }) => {
  await resetBrowser(page);
  const dialog = page.getByRole("dialog", { name: "Account" });
  await expect(dialog).toBeVisible();
  const signIn = await violations(page, "sign-in");
  await dialog.getByRole("button", { name: "Create account" }).first().click();
  await expect(dialog.getByLabel("Name")).toBeVisible();
  const signUp = await violations(page, "create-account");
  expect([...signIn, ...signUp]).toEqual([]);
});

test("the table terminal: floor, a table, its bill, settling and sales", async ({ page }) => {
  test.slow();
  await resetBrowser(page);
  const restaurant = await createRestaurant(page, freshName("Terminal"));
  await openTerminal(page, restaurant);
  const floor = await violations(page, "pos-floor");

  await page.getByTestId("pos-table-T1").click();
  await expect(page.getByRole("dialog", { name: "Seat guests" })).toBeVisible();
  const seat = await violations(page, "pos-seat-guests");
  await page.getByTestId("pos-confirm-open-table").click();
  await expect(page.getByRole("region", { name: "Table T1" })).toBeVisible();
  await page.getByRole("button", { name: /Paneer Tikka/ }).click();
  const table = await violations(page, "pos-table");
  await addDishAndFire(page, /Chicken Kari \(Full\)/);

  await page.getByTestId("pos-open-bill").click();
  await expect(page.getByRole("dialog", { name: "Bill" })).toBeVisible();
  const bill = await violations(page, "pos-bill");
  await page.getByRole("dialog", { name: "Bill" }).getByRole("button", { name: "Close" }).click();

  await page.getByTestId("pos-settle").click();
  const settle = await violations(page, "pos-settle");
  await page.getByTestId("pos-confirm-settle").click();
  await expect(page.getByTestId("pos-close-receipt")).toBeVisible();
  const receipt = await violations(page, "pos-receipt");
  await page.getByTestId("pos-close-receipt").click();

  await page.getByRole("button", { name: /Sales today/ }).click();
  await expect(page.getByRole("dialog").first()).toBeVisible();
  const sales = await violations(page, "pos-sales");
  expect([...floor, ...seat, ...table, ...bill, ...settle, ...receipt, ...sales]).toEqual([]);
});

test("the owner workspace", async ({ page }) => {
  await resetBrowser(page);
  const restaurant = await createRestaurant(page, freshName("Owner"));
  await page.goto("/owner");
  const picker = page.getByLabel("Restaurant", { exact: true });
  if (await picker.isVisible().catch(() => false)) await picker.selectOption({ label: restaurant.name });
  await expect(page.getByTestId("restaurant-team")).toBeVisible();
  expect(await violations(page, "owner")).toEqual([]);
});

test("the restaurant's public menu and the account page", async ({ page }) => {
  await resetBrowser(page);
  const restaurant = await createRestaurant(page, freshName("Public"), { publish: true });
  await page.goto(`/r/${restaurant.slug}`);
  await expect(page.getByRole("heading", { level: 1, name: restaurant.name })).toBeVisible();
  const menu = await violations(page, "public-menu");
  await signInAsStaff(page);
  await page.goto("/account");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const account = await violations(page, "account");
  expect([...menu, ...account]).toEqual([]);
});
