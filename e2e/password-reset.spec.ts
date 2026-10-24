import { expect, test, type Page } from "@playwright/test";
import { registerAccount, resetBrowser, uniqueEmail } from "./helpers";
import { latestResetLink, subjectsFor } from "./mailbox";

const OLD_PASSWORD = "135792";
const NEW_PASSWORD = "246812";

async function waitForResetLink(email: string): Promise<string> {
  await expect.poll(() => latestResetLink(email), { timeout: 15_000 }).not.toBeNull();
  const link = latestResetLink(email);
  if (!link) throw new Error(`No reset email reached ${email}.`);
  return link;
}

async function requestResetLink(page: Page, email: string): Promise<string> {
  const response = await page.request.post("/api/webroutes/auth/forgot", { data: { email } });
  expect(response.status()).toBe(200);
  return waitForResetLink(email);
}

async function chooseNewPassword(page: Page, password: string, confirmation = password) {
  await page.getByLabel("New PIN").fill(password);
  await page.getByLabel("Type it again").fill(confirmation);
}

test.describe("Forgotten password", () => {
  test("recovers the account from the emailed link and signs in with the new password", async ({
    page,
  }) => {
    const email = uniqueEmail("forgot");
    await resetBrowser(page);
    await registerAccount(page, email, OLD_PASSWORD);
    await page.request.post("/api/webroutes/auth/logout");

    await page.goto("/signin");
    const dialog = page.getByRole("dialog", { name: "Account" });
    await dialog.getByLabel("Email", { exact: true }).fill(email);
    await dialog.getByRole("button", { name: "Forgot PIN?" }).click();

    await expect(dialog.getByRole("heading", { name: "Reset your PIN" })).toBeVisible();
    // What they typed to sign in carries over, and the field is ready for them.
    const address = dialog.getByLabel("Email you signed up with");
    await expect(address).toHaveValue(email);
    await expect(address).toBeFocused();
    await dialog.getByRole("button", { name: "Email me a reset link" }).click();

    await expect(dialog.getByRole("heading", { name: "Check your inbox" })).toBeFocused();
    await expect(dialog.getByTestId("forgot-sent")).toContainText(email);

    await page.goto(await waitForResetLink(email));
    await chooseNewPassword(page, NEW_PASSWORD);
    await page.getByRole("button", { name: "Save new PIN" }).click();

    await expect(page.getByRole("heading", { name: "PIN updated" })).toBeFocused();
    // The spent token does not stay in the address bar.
    expect(new URL(page.url()).hash).toBe("");
    await expect.poll(() => subjectsFor(email)).toContain("Your KRAVE PIN was changed");

    await page.getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/signin$/);
    const signIn = page.getByRole("dialog", { name: "Account" });
    await signIn.getByLabel("Email", { exact: true }).fill(email);
    await signIn.getByLabel(/^PIN/).fill(NEW_PASSWORD);
    await signIn.getByTestId("account-submit").click();
    await expect(page.getByTestId("navbar-account")).toHaveAttribute("title", /Signed in as/);

    const old = await page.request.post("/api/webroutes/auth/login", {
      data: { email, password: OLD_PASSWORD },
    });
    expect(old.status()).toBe(400);
  });

  test("says a used link no longer works and offers a new one", async ({ page }) => {
    const email = uniqueEmail("reused");
    await resetBrowser(page);
    await registerAccount(page, email, OLD_PASSWORD);
    const link = await requestResetLink(page, email);
    const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token");
    const spent = await page.request.post("/api/webroutes/auth/reset", {
      data: { token, password: NEW_PASSWORD },
    });
    expect(spent.status()).toBe(200);

    await page.goto(link);
    await chooseNewPassword(page, "246817");
    await page.getByRole("button", { name: "Save new PIN" }).click();

    await expect(page.getByRole("heading", { name: "This link no longer works" })).toBeFocused();
    await expect(page.getByText(/expired or was already used/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Email me a reset link" })).toBeVisible();
  });

  test("saves once when the button is double-clicked on a slow connection", async ({ page }) => {
    const email = uniqueEmail("double");
    await resetBrowser(page);
    await registerAccount(page, email, OLD_PASSWORD);
    const link = await requestResetLink(page, email);

    let resets = 0;
    await page.route("**/api/webroutes/auth/reset", async (route) => {
      resets += 1;
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.continue();
    });
    await page.goto(link);
    await chooseNewPassword(page, NEW_PASSWORD);
    await page.getByRole("button", { name: "Save new PIN" }).dblclick();

    await expect(page.getByRole("heading", { name: "PIN updated" })).toBeVisible();
    expect(resets).toBe(1);
  });

  test("catches a mismatched confirmation without sending anything", async ({ page }) => {
    const resets: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/auth/reset")) resets.push(request.url());
    });
    await page.goto(`/reset-password#token=${"a".repeat(43)}`);
    await chooseNewPassword(page, "135799", "246819");
    await page.getByRole("button", { name: "Save new PIN" }).click();

    await expect(page.getByTestId("reset-form").getByRole("alert")).toHaveText(
      "The two PINs don't match."
    );
    await expect(page.getByLabel("New PIN")).toHaveAttribute("aria-invalid", "true");
    expect(resets).toEqual([]);
  });

  test("explains where the link comes from when opened without one, at phone width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/reset-password");

    await expect(page.getByRole("heading", { name: "Open the link from your email" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Email me a reset link" })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
