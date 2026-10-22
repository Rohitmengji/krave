import { expect, test } from "@playwright/test";
import { registerAccount, resetBrowser, uniqueEmail } from "./helpers";

const PASSWORD = "e2e-demo-password";

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

  test("scopes orders to their own account", async ({ page }) => {
    const owner = uniqueEmail("owner");
    const other = uniqueEmail("other");

    await resetBrowser(page);
    await registerAccount(page, owner, PASSWORD);
    const order = await page.request.post("/api/webroutes/order/makeOrder", {
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
    const orderId = (await order.json()).order.orderId;

    await page.request.post("/api/webroutes/auth/logout");
    await registerAccount(page, other, PASSWORD);

    const me = await (await page.request.get("/api/webroutes/account/me")).json();
    expect(me.orders).toHaveLength(0);

    const cancel = await page.request.post("/api/webroutes/order/cancel", { data: { orderId } });
    expect(cancel.status()).toBe(400);
  });

  test("returns the original order when an idempotency key is replayed", async ({ page }) => {
    await resetBrowser(page);
    await registerAccount(page, uniqueEmail("idempotent"), PASSWORD);

    const key = crypto.randomUUID();
    const payload = {
      items: [{ itemId: "ctl_820099425", quantity: 1, optionIds: ["opt_500g"] }],
      addressId: "addr_cp_514",
      paymentMethod: "UPI (demo)",
      couponCode: null,
      isGoldMember: false,
      riderTip: 0,
    };

    const first = await (
      await page.request.post("/api/webroutes/order/makeOrder", {
        headers: { "Idempotency-Key": key },
        data: payload,
      })
    ).json();
    const second = await (
      await page.request.post("/api/webroutes/order/makeOrder", {
        headers: { "Idempotency-Key": key },
        data: payload,
      })
    ).json();

    expect(second.order.orderId).toBe(first.order.orderId);
    expect(second.replayed).toBe(true);

    const me = await (await page.request.get("/api/webroutes/account/me")).json();
    expect(me.orders).toHaveLength(1);
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
