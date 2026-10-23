import { expect, test } from "@playwright/test";
import { registerAccount, resetBrowser, uniqueEmail } from "./helpers";

const PASSWORD = "e2e-demo-password";
const OUTLET_ID = 19677790;

// Delivery tickets and refund claims belong to the retired sample-catalog checkout, so only
// their access control is left to exercise in a browser; the engines keep their unit tests.
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
});
