import { expect, test, type Page } from "@playwright/test";
import { registerAccount, resetBrowser, uniqueEmail } from "./helpers";
import { latestConfirmLink, subjectsFor } from "./mailbox";

const PASSWORD = "135791";

async function waitForConfirmLink(address: string): Promise<string> {
  await expect.poll(() => latestConfirmLink(address), { timeout: 15_000 }).not.toBeNull();
  return latestConfirmLink(address) ?? "";
}

async function openAccount(page: Page, prefix: string): Promise<string> {
  const email = uniqueEmail(prefix);
  await resetBrowser(page);
  await registerAccount(page, email, PASSWORD);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  return email;
}

test.describe("Account settings", () => {
  test("is reached from the account dialog, and asks a signed-out visitor to sign in", async ({
    page,
  }) => {
    await resetBrowser(page);
    await page.goto("/account");
    await expect(page.getByTestId("account-signed-out")).toBeVisible();

    const email = uniqueEmail("dialog");
    await registerAccount(page, email, PASSWORD);
    await page.goto("/");
    await page.getByTestId("navbar-account").click();
    await page.getByRole("link", { name: "Manage account" }).click();
    await expect(page).toHaveURL(/\/account$/);
    await expect(page.getByTestId("account-email")).toContainText(email);
  });

  test("saves a name and a mobile number, and explains a bad number", async ({ page }) => {
    await openAccount(page, "profile");
    const profile = page.getByTestId("account-profile");

    await profile.getByLabel("Mobile number (optional)").fill("12345");
    await profile.getByRole("button", { name: "Save profile" }).click();
    await expect(profile.getByRole("alert")).toContainText("10-digit mobile number");

    await profile.getByLabel("Name").fill("Rohit Mengji");
    await profile.getByLabel("Mobile number (optional)").fill("98765-43210");
    await profile.getByRole("button", { name: "Save profile" }).click();
    await expect(profile.getByRole("status")).toHaveText("Profile saved.");

    await page.reload();
    await expect(page.getByTestId("account-profile").getByLabel("Name")).toHaveValue("Rohit Mengji");
    await expect(page.getByTestId("account-profile").getByLabel("Mobile number (optional)")).toHaveValue(
      "+91 98765 43210"
    );
  });

  test("changes the password and keeps this device signed in", async ({ page, browser }) => {
    const email = await openAccount(page, "password");
    const section = page.getByTestId("account-password");

    await section.getByLabel("Current PIN").fill(PASSWORD);
    await section.getByLabel("New PIN", { exact: true }).fill("246811");
    await section.getByLabel("Type the new PIN again").fill("246811");
    await section.getByRole("button", { name: "Change PIN" }).click();
    await expect(section.getByRole("status")).toContainText("PIN changed");
    await expect.poll(() => subjectsFor(email)).toContain("Your KRAVE PIN was changed");

    // Still signed in here.
    await page.reload();
    await expect(page.getByTestId("account-settings")).toBeVisible();

    const elsewhere = await browser.newContext();
    try {
      const login = (password: string) =>
        elsewhere.request.post(`${new URL(page.url()).origin}/api/webroutes/auth/login`, {
          data: { email, password },
        });
      expect((await login(PASSWORD)).status()).toBe(400);
      expect((await login("246811")).status()).toBe(201);
    } finally {
      await elsewhere.close();
    }
  });

  test("confirms the address from the emailed link", async ({ page }) => {
    const email = await openAccount(page, "confirm");
    const section = page.getByTestId("account-email");
    await expect(section).toContainText("Not confirmed");

    await page.goto(await waitForConfirmLink(email));
    await page.getByRole("button", { name: "Confirm email address" }).click();
    await expect(page.getByRole("heading", { name: "Email address confirmed" })).toBeFocused();
    expect(new URL(page.url()).hash).toBe("");

    await page.getByRole("link", { name: "Go to your account" }).click();
    await expect(page.getByTestId("account-email")).toContainText("Confirmed");
    await expect(page.getByTestId("account-email")).not.toContainText("Not confirmed");
  });

  test("moves the account to a new address only after that address confirms", async ({ page }) => {
    const email = await openAccount(page, "move");
    const newEmail = uniqueEmail("moved");
    const section = page.getByTestId("account-email");

    await section.getByRole("button", { name: "Change email address" }).click();
    await section.getByLabel("New email address").fill(newEmail);
    await section.getByLabel("Current PIN").fill(PASSWORD);
    await section.getByRole("button", { name: "Send link to new address" }).click();
    await expect(page.getByTestId("email-change-form").getByRole("status")).toContainText(
      `Check ${newEmail}`
    );
    await expect(section).toContainText(email);

    await page.goto(await waitForConfirmLink(newEmail));
    await page.getByRole("button", { name: "Confirm email address" }).click();
    await expect(page.getByRole("heading", { name: "Email address changed" })).toBeVisible();
    await expect.poll(() => subjectsFor(email)).toContain("Your KRAVE email address was changed");

    await page.goto("/account");
    await expect(page.getByTestId("account-email")).toContainText(newEmail);
  });

  test("signs out every device after confirming", async ({ page }) => {
    await openAccount(page, "everywhere");
    await page.getByRole("button", { name: "Sign out everywhere" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Sign out on every device?" });
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await dialog.getByRole("button", { name: "Sign out everywhere" }).click();
    await expect(page.getByRole("heading", { name: "You're signed out everywhere" })).toBeVisible();

    await page.goto("/account");
    await expect(page.getByTestId("account-signed-out")).toBeVisible();
  });

  test("deletes the account only with the password and the typed word, at phone width", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    const email = await openAccount(page, "delete");

    await page.getByRole("button", { name: "Delete account..." }).click();
    const dialog = page.getByRole("alertdialog", { name: "Delete your account?" });
    const password = dialog.getByLabel("PIN");
    await expect(password).toBeFocused();
    const confirm = dialog.getByRole("button", { name: "Delete account" });
    await expect(confirm).toBeDisabled();

    // Escape backs out and leaves nothing half-typed for next time.
    await password.fill(PASSWORD);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "Delete account..." }).click();
    await expect(dialog.getByLabel("PIN")).toHaveValue("");

    await dialog.getByLabel("PIN").fill("not-the-password");
    await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
    await confirm.click();
    await expect(dialog.getByRole("alert")).toHaveText("Your current PIN is incorrect.");
    await expect(page.getByTestId("account-settings")).toBeVisible();

    await dialog.getByLabel("PIN").fill(PASSWORD);
    await confirm.click();
    await expect(page.getByRole("heading", { name: "Your account was deleted" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    const login = await page.request.post("/api/webroutes/auth/login", {
      data: { email, password: PASSWORD },
    });
    expect(login.status()).toBe(400);
  });
});
