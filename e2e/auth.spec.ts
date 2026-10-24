import { expect, test } from "@playwright/test";
import { registerAccount, resetBrowser, uniqueEmail } from "./helpers";

const PASSWORD = "135790";

test.describe("Auth hardening", () => {
  test("throttles sign-in and refuses even the correct password while locked", async ({ page }) => {
    const email = uniqueEmail("throttle");
    await resetBrowser(page);
    await registerAccount(page, email, PASSWORD);
    await page.request.post("/api/webroutes/auth/logout");

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await page.request.post("/api/webroutes/auth/login", {
        data: { email, password: "definitely-not-the-password" },
      });
    }

    const locked = await page.request.post("/api/webroutes/auth/login", {
      data: { email, password: PASSWORD },
    });
    expect(locked.status()).toBe(400);
    expect((await locked.json()).message).toContain("Too many sign-in attempts");
  });

  test("answers forgot-password identically for known and unknown addresses", async ({ page }) => {
    const email = uniqueEmail("enumerate");
    await resetBrowser(page);
    await registerAccount(page, email, PASSWORD);

    const known = await page.request.post("/api/webroutes/auth/forgot", { data: { email } });
    const unknown = await page.request.post("/api/webroutes/auth/forgot", {
      data: { email: uniqueEmail("ghost") },
    });

    expect(known.status()).toBe(unknown.status());
    expect(await known.json()).toEqual(await unknown.json());
  });

  // Requiring a JSON body on these has silently broken sign-out twice.
  test("accepts bodyless sign-out requests", async ({ page }) => {
    await resetBrowser(page);
    await registerAccount(page, uniqueEmail("bodyless"), PASSWORD);

    const everywhere = await page.request.post("/api/webroutes/auth/logout-everywhere");
    expect(everywhere.status()).toBe(200);

    const guest = await (await page.request.get("/api/webroutes/account/me")).json();
    expect(guest.guest).toBe(true);

    const plain = await page.request.post("/api/webroutes/auth/logout");
    expect(plain.status()).toBe(200);

    const denied = await page.request.post("/api/webroutes/auth/logout-everywhere");
    expect(denied.status()).toBe(401);
    expect((await denied.json()).message).not.toBe("Invalid JSON request.");
  });

  test("refuses unknown endpoints", async ({ page }) => {
    await resetBrowser(page);
    expect((await page.request.get("/api/webroutes/not/a/route")).status()).toBe(404);
    expect(
      (await page.request.post("/api/webroutes/not/a/route", { data: {} })).status()
    ).toBe(404);
  });
});
