import { expect, test } from "@playwright/test";
import { registerAccount, resetBrowser, signInAsStaff, uniqueEmail } from "./helpers";

const PASSWORD = "e2e-demo-password";
const DISH_ID = "ctl_raj_kachori";
const OUTLET_PATH = "/restaurant/19677790";

/**
 * Clears the shared 86 list so one spec cannot leave another with a hidden menu.
 * The list is outlet-wide and durable by design, so cleanup needs a signed-in operator;
 * an anonymous call would 401 and silently leave the dish off.
 */
async function restoreMenu(page: import("@playwright/test").Page) {
  await page.request.post("/api/webroutes/auth/logout");
  await signInAsStaff(page);

  const current = await (await page.request.get("/api/webroutes/menu/availability")).json();
  for (const itemId of current.unavailableItemIds as string[]) {
    const cleared = await page.request.post("/api/webroutes/menu/availability", {
      data: { itemId, unavailable: false },
    });
    expect(cleared.status()).toBe(200);
  }

  await page.request.post("/api/webroutes/auth/logout");
}

test.describe("Outlet-wide availability", () => {
  // The 86 list is shared and durable by design, so each case has to start from a full menu.
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await restoreMenu(page);
  });

  test.afterEach(async ({ page }) => {
    await restoreMenu(page);
  });

  test("returns the whole list when no outlet is given", async ({ page }) => {
    await resetBrowser(page);
    await signInAsStaff(page);
    await page.request.post("/api/webroutes/menu/availability", {
      data: { itemId: DISH_ID, unavailable: true },
    });

    const all = await (await page.request.get("/api/webroutes/menu/availability")).json();
    expect(all.unavailableItemIds).toContain(DISH_ID);

    const scoped = await (
      await page.request.get("/api/webroutes/menu/availability?outletId=19677790")
    ).json();
    expect(scoped.unavailableItemIds).toContain(DISH_ID);

    const otherOutlet = await (
      await page.request.get("/api/webroutes/menu/availability?outletId=18238278")
    ).json();
    expect(otherOutlet.unavailableItemIds).not.toContain(DISH_ID);
  });

  test("refuses a signed-out browser the power to change a menu", async ({ page }) => {
    await resetBrowser(page);

    const denied = await page.request.post("/api/webroutes/menu/availability", {
      data: { itemId: DISH_ID, unavailable: true },
    });
    expect(denied.status()).toBe(401);

    // Reading stays open, because every customer needs an honest menu.
    const read = await page.request.get("/api/webroutes/menu/availability");
    expect(read.status()).toBe(200);
  });

  test("refuses a signed-in customer who is not staff at that outlet", async ({ page }) => {
    await resetBrowser(page);
    await registerAccount(page, uniqueEmail("customer"), PASSWORD);

    const denied = await page.request.post("/api/webroutes/menu/availability", {
      data: { itemId: DISH_ID, unavailable: true },
    });
    expect(denied.status()).toBe(400);
    expect((await denied.json()).message).toMatch(/do not have access/i);

    // The menu is unchanged, so a customer cannot take a rival's dish off sale.
    const read = await (await page.request.get("/api/webroutes/menu/availability")).json();
    expect(read.unavailableItemIds).not.toContain(DISH_ID);
  });

  test("hides a dish from a different browser once the kitchen marks it off", async ({
    page,
    browser,
  }) => {
    await resetBrowser(page, OUTLET_PATH);
    await signInAsStaff(page);
    await page.reload({ waitUntil: "networkidle" });

    await page.getByTestId(`toggle-availability-${DISH_ID}`).click();
    await expect(page.getByTestId(`add-dish-${DISH_ID}`)).toBeDisabled();

    // A completely separate, signed-out browser must see the same thing.
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    await guest.goto(OUTLET_PATH, { waitUntil: "networkidle" });
    await expect(guest.getByTestId(`add-dish-${DISH_ID}`)).toBeDisabled();
    await expect(guest.getByTestId(`dish-card-${DISH_ID}`)).toContainText("86");
    await guestContext.close();
  });

  test("refuses checkout for a dish that sold out after it was added", async ({
    page,
    browser,
  }) => {
    await resetBrowser(page, OUTLET_PATH);

    // The customer adds the dish while it is still available.
    await page.getByTestId(`add-dish-${DISH_ID}`).click();
    await page.getByRole("button", { name: /Add Item to Cart/ }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("floating-cart-bar")).toBeVisible();

    // Meanwhile the counter takes it off.
    const staffContext = await browser.newContext();
    const staff = await staffContext.newPage();
    await staff.goto("/");
    await signInAsStaff(staff);
    const marked = await staff.request.post("/api/webroutes/menu/availability", {
      data: { itemId: DISH_ID, unavailable: true },
    });
    expect(marked.status()).toBe(200);

    // The server must refuse it even though this browser still shows it in the cart.
    const attempt = await page.request.post("/api/webroutes/order/makeOrder", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {
        items: [{ itemId: DISH_ID, quantity: 1, optionIds: [] }],
        addressId: "addr_cp_514",
        paymentMethod: "UPI (demo)",
        couponCode: null,
        isGoldMember: false,
        riderTip: 0,
      },
    });
    expect(attempt.status()).toBe(400);
    expect((await attempt.json()).message).toMatch(/sold out/i);

    await staff.request.post("/api/webroutes/menu/availability", {
      data: { itemId: DISH_ID, unavailable: false },
    });
    await staffContext.close();
  });

  test("removes a dish from the terminal menu too", async ({ page }) => {
    await resetBrowser(page, "/pos");
    await signInAsStaff(page);

    const marked = await page.request.post("/api/webroutes/menu/availability", {
      data: { itemId: DISH_ID, unavailable: true },
    });
    expect(marked.status()).toBe(200);

    await page.goto("/pos", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: /Menu/ })).toContainText("marked 86");
    await expect(page.getByRole("button", { name: /Royal Raj Kachori/ })).toHaveCount(0);
  });
});

test.describe("Server-side notifications", () => {
  test("keeps the inbox after local storage is wiped", async ({ page }) => {
    await resetBrowser(page);
    await registerAccount(page, uniqueEmail("inbox"), PASSWORD);
    await page.reload({ waitUntil: "networkidle" });

    await page.request.post("/api/webroutes/order/makeOrder", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {
        items: [{ itemId: "ctl_820099425", quantity: 1, optionIds: ["opt_500g"] }],
        addressId: "addr_cp_514",
        paymentMethod: "UPI (demo)",
        couponCode: null,
        isGoldMember: false,
        riderTip: 0,
      },
    });

    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle" });

    await expect(page.getByTestId("inbox-unread-badge")).toHaveText("1");
    await page.getByTestId("navbar-inbox").click();
    await expect(page.getByTestId("notification-entry").first()).toContainText(
      "Demo order confirmed"
    );

    // Reading is persisted, so the badge stays gone across a reload.
    await page.keyboard.press("Escape");
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByTestId("inbox-unread-badge")).toHaveCount(0);
  });

  test("does not leak one account's inbox to another", async ({ page }) => {
    await resetBrowser(page);
    await registerAccount(page, uniqueEmail("first"), PASSWORD);
    await page.request.post("/api/webroutes/user/booking", {
      data: {
        resId: 19677790,
        date: "Today, Oct 22",
        timeSlot: "07:30 PM",
        guests: 2,
        guestName: "Rohit Mengji",
        guestPhone: "+91 98765 43210",
      },
    });
    const owner = await (await page.request.get("/api/webroutes/account/me")).json();
    expect(owner.notifications.length).toBeGreaterThan(0);

    await page.request.post("/api/webroutes/auth/logout");
    await registerAccount(page, uniqueEmail("second"), PASSWORD);
    const other = await (await page.request.get("/api/webroutes/account/me")).json();
    expect(other.notifications).toHaveLength(0);
  });
});
