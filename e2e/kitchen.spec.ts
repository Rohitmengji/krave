import { expect, test } from "@playwright/test";
import { registerAccount, resetBrowser, uniqueEmail } from "./helpers";

const PASSWORD = "e2e-demo-password";
const OUTLET_ID = 19677790;

const ORDER = {
  items: [{ itemId: "ctl_820099425", quantity: 1, optionIds: ["opt_500g"] }],
  addressId: "addr_cp_514",
  paymentMethod: "UPI (demo)",
  couponCode: null,
  isGoldMember: false,
  riderTip: 0,
};

test.describe("Kitchen tickets", () => {
  test("refuses the counter to a signed-out browser", async ({ page }) => {
    await resetBrowser(page);

    const tickets = await page.request.get(
      `/api/webroutes/kitchen/tickets?outletId=${OUTLET_ID}`
    );
    expect(tickets.status()).toBe(401);

    const advance = await page.request.post("/api/webroutes/kitchen/ticket", {
      data: { orderId: "KRV-anything", status: "ACCEPTED" },
    });
    expect(advance.status()).toBe(401);
  });

  test("rejects an allergy with no stated trigger", async ({ page }) => {
    await resetBrowser(page);

    const refused = await page.request.post("/api/webroutes/order/makeOrder", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: { ...ORDER, handling: { flags: ["ALLERGY"], allergyNote: "" } },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).message).toMatch(/what the allergy is/i);
  });

  test("carries a customer's allergy onto the counter without their address", async ({
    page,
    browser,
  }) => {
    // A signed-out customer orders with an allergy.
    await resetBrowser(page);
    const placed = await page.request.post("/api/webroutes/order/makeOrder", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: {
        ...ORDER,
        handling: { flags: ["ALLERGY", "NO_CUTLERY"], allergyNote: "severe peanut allergy" },
      },
    });
    expect(placed.status()).toBe(201);
    const orderId = (await placed.json()).order.orderId;

    // A separate operator opens the counter.
    const counterContext = await browser.newContext();
    const counter = await counterContext.newPage();
    await counter.goto("/pos");
    await registerAccount(counter, uniqueEmail("counter"), PASSWORD);
    await counter.reload({ waitUntil: "networkidle" });

    const ticket = counter.getByTestId(`pos-ticket-${orderId}`);
    await expect(ticket).toBeVisible({ timeout: 20_000 });
    await expect(counter.getByTestId(`pos-ticket-critical-${orderId}`)).toContainText(
      "severe peanut allergy"
    );
    await expect(ticket).toContainText("Ghee Assorted Sweets Box");

    // The counter must not be able to read the customer's address off the ticket.
    const payload = await (
      await counter.request.get(`/api/webroutes/kitchen/tickets?outletId=${OUTLET_ID}`)
    ).json();
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/Connaught Place/i);
    expect(serialized).not.toMatch(/110001/);

    // And it moves forward one step at a time.
    await counter.getByTestId(`pos-ticket-advance-${orderId}`).click();
    await expect(ticket).toContainText("Cooking");
    await counter.getByTestId(`pos-ticket-advance-${orderId}`).click();
    await expect(ticket).toBeHidden();

    await counterContext.close();
  });

  test("places an order with handling through the checkout UI", async ({ page }) => {
    await resetBrowser(page, "/restaurant/19677790");

    await page.getByTestId("add-dish-ctl_820099425").click();
    await page.getByRole("button", { name: /Add Item to Cart/ }).click();
    await page.keyboard.press("Escape");
    await page.getByTestId("floating-cart-bar").click();

    await page.getByTestId("kitchen-flag-ALLERGY").click();
    // The order cannot be placed until the kitchen is told what the allergy is.
    await expect(page.getByTestId("place-order-zpaykit-btn")).toBeDisabled();

    await page.getByTestId("allergy-note").fill("severe peanut allergy");
    await expect(page.getByTestId("place-order-zpaykit-btn")).toBeEnabled();

    await page.getByTestId("place-order-zpaykit-btn").click();
    await expect(page.getByTestId("crystal-tracking-modal")).toBeVisible({ timeout: 15_000 });
  });
});
