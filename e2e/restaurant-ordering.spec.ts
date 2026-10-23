import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { registerAccount, resetBrowser, signInAsStaff, uniqueEmail } from "./helpers";

/**
 * Online ordering for a managed restaurant, end to end: the owner switches it on, a customer
 * orders from the public menu, and the kitchen moves the order through its lifecycle while
 * the customer watches. Payment is always offline (cash or UPI at the counter or door).
 */

const SLUG = `jagadamba-orders-${Date.now().toString(36)}`;
const NAME = "Jagadamba Orders E2E";

let restaurantId = "";
let firstOrderPath = "";
let secondOrderPath = "";

async function json<T>(response: Awaited<ReturnType<APIRequestContext["get"]>>): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return (await response.json()) as T;
}

async function ownerPage(page: Page) {
  await resetBrowser(page);
  await signInAsStaff(page);
  await page.goto("/owner");
  const picker = page.getByLabel("Restaurant", { exact: true });
  // Other specs share this account, so pick this spec's restaurant when there are several.
  if (await picker.isVisible().catch(() => false)) await picker.selectOption({ label: NAME });
  await expect(page.getByRole("heading", { level: 2, name: NAME, exact: true })).toBeVisible();
}

async function customerPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/r/${SLUG}`);
  return { context, page };
}

async function fillDetails(page: Page) {
  const checkout = page.getByTestId("managed-checkout");
  await checkout.getByLabel("Your name").fill("Ravi Patil");
  await checkout.getByLabel("Phone number").fill("98450 12345");
  await checkout.getByRole("radio", { name: "Takeaway" }).check();
}

test.describe.serial("Restaurant ordering", () => {
  test("ordering stays off until the owner switches it on", async ({ page, browser }) => {
    await resetBrowser(page);
    await signInAsStaff(page);
    const created = await json<{ restaurant: { id: string } }>(
      await page.request.post("/api/owner", { data: { name: NAME, slug: SLUG, city: "Wadi", state: "Karnataka" } })
    );
    restaurantId = created.restaurant.id;
    await json(
      await page.request.patch(`/api/owner/${restaurantId}`, {
        data: {
          phone: "08442 200100",
          takeawayEnabled: true,
          dineInEnabled: false,
          deliveryEnabled: true,
          serviceAreas: ["Wadi"],
          deliveryFeePaise: 2_000,
        },
      })
    );
    const { category } = await json<{ category: { id: string } }>(
      await page.request.post(`/api/owner/${restaurantId}/menu`, { data: { type: "category", name: "Biriyani" } })
    );
    for (const item of [
      {
        name: "Chicken Biriyani",
        pricePaise: 6_000,
        variants: [
          { name: "Half", priceDeltaPaise: 0 },
          { name: "Full", priceDeltaPaise: 4_000 },
        ],
      },
      { name: "Jowar Roti", pricePaise: 1_500 },
    ]) {
      await json(
        await page.request.post(`/api/owner/${restaurantId}/menu`, {
          data: { type: "item", categoryId: category.id, published: true, available: true, ...item },
        })
      );
    }
    await json(await page.request.post(`/api/owner/${restaurantId}`, { data: { action: "publish" } }));

    const customer = await customerPage(browser);
    await expect(customer.page.getByRole("region", { name: "Ordering status" })).toContainText("Online ordering is paused");
    await expect(customer.page.getByRole("link", { name: "08442 200100" })).toBeVisible();
    await expect(customer.page.getByRole("button", { name: /^Add / })).toHaveCount(0);
    await customer.context.close();

    await ownerPage(page);
    const ordering = page.getByRole("region", { name: "Online ordering" });
    await ordering.getByRole("button", { name: "Start taking orders" }).click();
    await expect(ordering.getByRole("button", { name: "Pause online orders" })).toBeVisible();
  });

  test("a customer orders a portion and a double tap places one order", async ({ browser, page }) => {
    const { context, page: customer } = await customerPage(browser);
    await customer.getByRole("button", { name: "Add Chicken Biriyani" }).click();
    const chooser = customer.getByRole("dialog", { name: "Add Chicken Biriyani" });
    await chooser.getByRole("radio", { name: /Full/ }).check();
    await chooser.getByRole("button", { name: "Add ₹100" }).click();
    await expect(chooser).toBeHidden();
    // A dish without choices goes straight into the cart.
    await customer.getByRole("button", { name: "Add Jowar Roti" }).click();

    await customer.getByRole("button", { name: /View order · 2 items/ }).click();
    await fillDetails(customer);
    await expect(customer.getByTestId("checkout-total")).toHaveText("₹115");

    const placeOrder = customer.getByRole("button", { name: "Place order · ₹115" });
    await placeOrder.dblclick();
    await customer.waitForURL(new RegExp(`/r/${SLUG}/orders/ord_[0-9a-f-]{36}$`));
    firstOrderPath = new URL(customer.url()).pathname;
    await expect(customer.getByTestId("order-status")).toHaveText("Waiting for the restaurant");
    await expect(customer.getByText("Pay at the restaurant, by cash or UPI.")).toBeVisible();

    await signInAsStaff(page);
    const { orders } = await json<{ orders: Array<{ orderNumber: number; totalPaise: number }> }>(
      await page.request.get(`/api/owner/${restaurantId}/orders?view=all`)
    );
    expect(orders).toEqual([expect.objectContaining({ orderNumber: 1, totalPaise: 11_500 })]);

    // The order is remembered on this device, and the cart is empty again.
    await customer.goto(`/r/${SLUG}`);
    await expect(customer.getByRole("link", { name: /Order #1/ })).toBeVisible();
    await expect(customer.getByRole("button", { name: /View order/ })).toHaveCount(0);
    await context.close();
  });

  test("the kitchen moves the order along and the customer sees each step", async ({ page, browser }) => {
    const { context, page: customer } = await customerPage(browser);
    await customer.goto(firstOrderPath);

    await ownerPage(page);
    const card = page.getByTestId("owner-order-1");
    await expect(card).toContainText("Ravi Patil");
    await expect(card).toContainText("1 × Chicken Biriyani · Full");

    for (const [action, label] of [
      ["Accept", "Accepted"],
      ["Start preparing", "Being prepared"],
      ["Mark ready", "Ready"],
    ] as const) {
      await card.getByRole("button", { name: new RegExp(`^${action}`) }).click();
      await expect(card.getByTestId("owner-order-status")).toHaveText(label);
      await customer.reload();
      await expect(customer.getByTestId("order-status")).toHaveText(label);
    }
    // Once accepted the customer can no longer withdraw it.
    await expect(customer.getByRole("button", { name: "Cancel order" })).toHaveCount(0);

    await card.getByRole("button", { name: /^Complete/ }).click();
    await expect(page.getByTestId("owner-order-1")).toHaveCount(0);
    await page.getByRole("button", { name: "Finished" }).click();
    await expect(page.getByTestId("owner-order-1").getByTestId("owner-order-status")).toHaveText("Completed");
    await customer.reload();
    await expect(customer.getByTestId("order-status")).toHaveText("Completed");
    await context.close();
  });

  test("a price change is shown before ordering and past orders keep their prices", async ({ page, browser }) => {
    const { context, page: customer } = await customerPage(browser);
    await customer.getByRole("button", { name: "Add Jowar Roti" }).click();

    // The owner raises the price while the customer's menu is open.
    await signInAsStaff(page);
    const menu = await json<{ categories: Array<{ id: string; items: Array<Record<string, unknown>> }> }>(
      await page.request.get(`/api/owner/${restaurantId}/menu`)
    );
    const category = menu.categories[0];
    const roti = category.items.find((item) => item.name === "Jowar Roti")!;
    await json(
      await page.request.post(`/api/owner/${restaurantId}/menu`, {
        data: { ...roti, type: "item", categoryId: category.id, pricePaise: 2_000 },
      })
    );
    const biriyani = category.items.find((item) => item.name === "Chicken Biriyani")!;
    await json(
      await page.request.post(`/api/owner/${restaurantId}/menu`, {
        data: { ...biriyani, type: "item", categoryId: category.id, name: "Chicken Dum Biriyani", pricePaise: 9_000 },
      })
    );

    await customer.getByRole("button", { name: /View order · 1 item/ }).click();
    // A different device starts with no remembered details.
    await expect(customer.getByTestId("managed-checkout").getByLabel("Your name")).toHaveValue("");
    await fillDetails(customer);
    await customer.getByRole("button", { name: "Place order · ₹15" }).click();
    await expect(customer.getByTestId("managed-checkout").getByRole("alert")).toContainText("Prices or charges changed");
    await expect(customer.getByTestId("checkout-total")).toHaveText("₹20");
    await customer.getByRole("button", { name: "Place order · ₹20" }).click();
    await customer.waitForURL(/\/orders\/ord_/);
    secondOrderPath = new URL(customer.url()).pathname;
    await expect(customer.getByTestId("order-status")).toHaveText("Waiting for the restaurant");

    // The completed order still shows what was sold, at the price it was sold for.
    await customer.goto(firstOrderPath);
    const items = customer.getByRole("region", { name: "Items" });
    await expect(items.getByRole("listitem").first()).toHaveText(/^1 × Chicken Biriyani · Full\s*₹100$/);
    await expect(items).not.toContainText("Chicken Dum Biriyani");
    await expect(items.getByRole("listitem").nth(1)).toHaveText(/^1 × Jowar Roti\s*₹15$/);
    await expect(items.getByRole("definition").last()).toHaveText("₹115");
    await context.close();
  });

  test("a customer can cancel before the kitchen accepts", async ({ page }) => {
    await page.goto(secondOrderPath);
    await page.getByRole("button", { name: "Cancel order" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Yes, cancel" }).click();
    await expect(page.getByTestId("order-status")).toHaveText("Cancelled");
    await expect(page.getByRole("button", { name: "Cancel order" })).toHaveCount(0);
  });

  test("ordering works on a phone-sized screen without sideways scrolling", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true });
    const phone = await context.newPage();
    await phone.goto(`/r/${SLUG}`);
    const overflow = () => phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);

    const add = phone.getByRole("button", { name: "Add Jowar Roti" });
    expect((await add.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await add.tap();
    const bar = phone.getByRole("button", { name: /View order · 1 item/ });
    await bar.tap();
    const checkout = phone.getByTestId("managed-checkout");
    await fillDetails(phone);
    expect(await overflow()).toBeLessThanOrEqual(0);
    const place = checkout.getByRole("button", { name: /^Place order/ });
    await place.scrollIntoViewIfNeeded();
    await expect(place).toBeInViewport();
    // The dialog is modal: tabbing on from its last control must never reach the page behind
    // it. (Past the end, a native modal hands focus to the browser's own UI, seen as <body>.)
    await place.focus();
    for (let step = 0; step < 3; step += 1) {
      await phone.keyboard.press("Tab");
      const escaped = await checkout.evaluate((dialog) => {
        const active = document.activeElement;
        return Boolean(active && active !== document.body && !dialog.contains(active));
      });
      expect(escaped).toBe(false);
    }
    await context.close();
  });

  test("orders are private to the restaurant and the order API refuses forgeries", async ({ browser, page }) => {
    const intruderContext = await browser.newContext();
    const intruder = await intruderContext.newPage();
    await registerAccount(intruder, uniqueEmail("order-intruder"), "intruder-password");
    expect((await intruder.request.get(`/api/owner/${restaurantId}/orders`)).status()).toBe(403);
    expect(
      (
        await intruder.request.patch(`/api/owner/${restaurantId}/orders`, {
          data: { orderId: "ord_00000000-0000-4000-8000-000000000000", from: "placed", to: "accepted" },
        })
      ).status()
    ).toBe(403);
    await intruderContext.close();

    const anonymous = await browser.newContext();
    expect((await anonymous.request.get(`/api/owner/${restaurantId}/orders`)).status()).toBe(401);
    expect((await anonymous.request.get("/api/public/orders/ord_00000000-0000-4000-8000-000000000000")).status()).toBe(404);
    const forged = await anonymous.request.post(`/api/public/restaurants/${SLUG}/orders`, {
      headers: { origin: "https://attacker.example" },
      data: {},
    });
    expect(forged.status()).toBe(403);
    const tampered = await anonymous.request.post(`/api/public/restaurants/${SLUG}/orders`, {
      data: {
        idempotencyKey: "e2e-tampered-0000000001",
        customerName: "Mallory",
        customerPhone: "9845012345",
        fulfilment: "takeaway",
        lines: [{ itemId: "itm_missing", variantId: null, addonIds: [], quantity: 1 }],
        expectedTotalPaise: 1,
      },
    });
    expect(tampered.status()).toBe(409);
    await anonymous.close();

    // The owner pauses ordering and the public page falls back to the phone number.
    await ownerPage(page);
    await page.getByRole("region", { name: "Online ordering" }).getByRole("button", { name: "Pause online orders" }).click();
    await expect(page.getByRole("button", { name: "Start taking orders" })).toBeVisible();
    const customer = await customerPage(browser);
    await expect(customer.page.getByRole("region", { name: "Ordering status" })).toContainText("paused");
    await customer.context.close();
  });
});
