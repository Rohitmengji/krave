import { expect, test } from "@playwright/test";
import { registerAccount, resetBrowser, signInAsStaff, uniqueEmail } from "./helpers";

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

test.describe("Refund claim queue", () => {
  test("refuses the queue to a signed-out browser", async ({ page }) => {
    await resetBrowser(page);
    expect((await page.request.get("/api/webroutes/ops/disputes")).status()).toBe(401);
    expect(
      (
        await page.request.post("/api/webroutes/ops/dispute/resolve", {
          data: { disputeId: "dsp_anything", approve: true },
        })
      ).status()
    ).toBe(401);
  });

  test("refuses the queue to a signed-in customer who is not staff", async ({ page }) => {
    await resetBrowser(page);
    await registerAccount(page, uniqueEmail("customer"), PASSWORD);

    expect((await page.request.get("/api/webroutes/ops/disputes")).status()).toBe(403);
    const settled = await page.request.post("/api/webroutes/ops/dispute/resolve", {
      data: { disputeId: "dsp_anything", approve: true },
    });
    expect(settled.status()).toBe(400);
    expect((await settled.json()).message).toMatch(/do not have access/i);
  });

  test("will not let a claimant approve their own refund", async ({ page }) => {
    await resetBrowser(page);

    // The staff account is also the customer here: that is the case the rule guards.
    await signInAsStaff(page);
    await page.reload({ waitUntil: "networkidle" });
    const placed = await page.request.post("/api/webroutes/order/makeOrder", {
      headers: { "Idempotency-Key": crypto.randomUUID() },
      data: ORDER,
    });
    const orderId = (await placed.json()).order.orderId;

    for (const stage of ["KITCHEN_PREPARING", "RIDER_ASSIGNED", "OUT_FOR_DELIVERY", "ARRIVED"]) {
      await page.request.post("/api/webroutes/order/stage", { data: { orderId, stage } });
    }

    // This order is above the automatic ceiling, so it queues for a person.
    const filed = await page.request.post("/api/webroutes/account/dispute", {
      data: {
        orderId,
        reason: "MISSING_ITEM",
        lines: [{ itemId: "ctl_820099425", quantity: 1 }],
      },
    });
    const dispute = (await filed.json()).dispute;
    expect(dispute.status).toBe("UNDER_REVIEW");

    const settled = await page.request.post("/api/webroutes/ops/dispute/resolve", {
      data: { disputeId: dispute.id, approve: true },
    });
    expect(settled.status()).toBe(400);
    expect((await settled.json()).message).toMatch(/your own claim/i);

    // Staff though they are, their own claim is not in their queue.
    const queue = await (await page.request.get("/api/webroutes/ops/disputes")).json();
    expect(queue.queue.some((entry: { id: string }) => entry.id === dispute.id)).toBe(false);

    // The claim is still unpaid.
    const me = await (await page.request.get("/api/webroutes/account/me")).json();
    const mine = me.disputes.find((entry: { id: string }) => entry.id === dispute.id);
    expect(mine.status).toBe("UNDER_REVIEW");
    expect(mine.refundAmount).toBe(0);
  });
});

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
    await signInAsStaff(counter);
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
