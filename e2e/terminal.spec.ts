import { expect, test, type Page } from "@playwright/test";
import { addDishAndFire, openTable, registerAccount, resetBrowser, STAFF_PASSWORD, uniqueEmail } from "./helpers";
import { createRestaurant, openTerminal, type E2eRestaurant } from "./restaurants";

const PASSWORD = "135790";
const PANEER = /Paneer Tikka/;
const KARI_FULL = /Chicken Kari \(Full\)/;

/**
 * Every test bills its own restaurant. The staff account's floor and shift live on the server,
 * so a shared outlet would hand one test the tables another left open.
 */
async function freshTerminal(page: Page, label: string): Promise<E2eRestaurant> {
  await resetBrowser(page);
  const restaurant = await createRestaurant(page, `Terminal ${label}`);
  await openTerminal(page, restaurant);
  return restaurant;
}

/** The outlet id the terminal bills under, and the Paneer Tikka's menu item id. */
async function posIds(page: Page, restaurant: E2eRestaurant) {
  const option = page.getByLabel("Outlet").locator("option", { hasText: restaurant.name });
  const outletId = Number(await option.getAttribute("value"));
  const menu = await (await page.request.get(`/api/owner/${restaurant.id}/menu`)).json();
  const paneer = menu.categories
    .flatMap((category: { items: { id: string; name: string }[] }) => category.items)
    .find((item: { name: string }) => item.name === "Paneer Tikka");
  return { outletId, itemId: String(paneer.id) };
}

function tableSession(outletId: number, outletName: string, itemId: string) {
  return {
    sessionId: `POS-${crypto.randomUUID()}`,
    outletId,
    outletName,
    tableId: "T1",
    guestCount: 2,
    serverName: "Asha",
    openedAt: new Date().toISOString(),
    status: "OPEN",
    lines: [
      {
        lineId: "L-1",
        itemId,
        name: "Paneer Tikka",
        unitPrice: 240,
        quantity: 1,
        dietary: "veg",
        note: "",
        kotNumber: 1,
      },
    ],
    voids: [],
    discountPercent: 0,
    serviceChargePercent: 0,
    nextKotNumber: 2,
    payment: null,
    shiftId: null,
    tickets: [
      {
        kotNumber: 1,
        firedAt: new Date().toISOString(),
        mergedFrom: null,
        lines: [{ name: "Paneer Tikka", quantity: 1, note: "", dietary: "veg" }],
      },
    ],
    mergedIntoSessionId: null,
    revision: 0,
  };
}

test.describe("Dine-in terminal", () => {
  test("bills from the restaurant's own menu, fires a ticket and reprints it", async ({ page }) => {
    await freshTerminal(page, "Reprint");
    await openTable(page, "T1");
    // Each portion of a dish is its own button, at the price on the restaurant's menu.
    await expect(page.getByRole("button", { name: /Chicken Kari \(Half\)/ })).toContainText("₹70");
    await addDishAndFire(page, PANEER);

    await expect(page.getByTestId("pos-grand-total")).toHaveText("₹252");

    // Void the item, then confirm the reprint still shows it.
    await page.getByRole("button", { name: "Void" }).click();
    await page.getByRole("textbox").last().fill("Guest changed order");
    await page.getByRole("button", { name: "Void Item" }).click();

    await page.getByText(/Kitchen tickets/).click();
    await page.getByTestId("pos-reprint-kot-1").click();
    const ticket = page.getByRole("dialog", { name: "Kitchen ticket" });
    await expect(ticket).toContainText("REPRINT");
    await expect(ticket).toContainText("Paneer Tikka");
  });

  test("takes guests' names and numbers and texts each one their share", async ({ page }) => {
    const restaurant = await freshTerminal(page, "Guests");
    await page.getByTestId("pos-table-T3").click();
    await page.getByLabel("Number of guests").fill("2");
    await page.getByTestId("pos-lead-guest-name").fill("Ramesh");
    await page.getByTestId("pos-lead-guest-phone").fill("12345");
    await page.getByTestId("pos-confirm-open-table").click();
    // A number that cannot be texted is refused before the table opens.
    await expect(page.getByRole("dialog", { name: "Seat guests" })).toContainText("10-digit");
    await page.getByTestId("pos-lead-guest-phone").fill("+91 98765-43210");
    await page.getByTestId("pos-confirm-open-table").click();
    await expect(page.getByTestId("pos-lead-guest")).toHaveText("Guest: Ramesh · 98765 43210");

    await addDishAndFire(page, PANEER);
    await addDishAndFire(page, KARI_FULL);
    await expect(page.getByTestId("pos-grand-total")).toHaveText("₹378");
    const message = `${restaurant.name}: Hi Ramesh, your bill for table T3 is Rs.378. Thank you!`;
    // This browser is a laptop: SMS goes out from a phone by scanning the code.
    await page.getByTestId("pos-sms-bill-open").click();
    const handoff = page.getByTestId("pos-sms-bill-handoff");
    await expect(handoff.getByRole("img", { name: /QR code/ })).toBeVisible();
    await expect(handoff).toContainText("1 SMS");
    const whole = page.getByTestId("pos-sms-bill");
    expect(decodeURIComponent((await whole.getAttribute("href")) ?? "")).toBe(
      `sms:+919876543210?&body=${message}`
    );
    expect(decodeURIComponent((await page.getByTestId("pos-sms-bill-whatsapp").getAttribute("href")) ?? "")).toBe(
      `https://wa.me/919876543210?text=${message}`
    );

    // A wrong number is corrected right where it is shown, and a bad one is refused.
    await page.getByTestId("pos-edit-lead-guest").click();
    await page.getByTestId("pos-guest-edit-phone").fill("98765 4321");
    await page.getByTestId("pos-guest-edit-save").click();
    await expect(page.getByTestId("pos-guest-editor-1")).toContainText("10-digit");
    await page.getByTestId("pos-guest-edit-phone").fill("90000 11111");
    await page.getByTestId("pos-guest-edit-save").click();
    await expect(page.getByTestId("pos-lead-guest")).toHaveText("Guest: Ramesh · 90000 11111");
    expect(await whole.getAttribute("href")).toMatch(/^sms:\+919000011111\?/);

    await page.getByTestId("pos-open-split").click();
    const split = page.getByRole("dialog", { name: "Split bill by guest" });
    await split.getByLabel("Assign Paneer Tikka").selectOption({ label: "Ramesh only" });
    await expect(split.getByTestId("pos-split-guest-1")).toContainText("₹315");
    await expect(split.getByTestId("pos-split-guest-2")).toContainText("₹63");

    await split.getByTestId("pos-guest-name-2").fill("Sunita");
    await split.getByTestId("pos-guest-phone-2").fill("91234 56789");
    await split.getByTestId("pos-guest-save-2").click();
    await expect(split.getByTestId("pos-guest-sms-2-open")).toContainText("SMS ₹63");
    await split.getByTestId("pos-guest-sms-2-open").click();
    const share = split.getByTestId("pos-guest-sms-2");
    expect(decodeURIComponent((await share.getAttribute("href")) ?? "")).toContain(
      "Hi Sunita, the bill for table T3 is Rs.378 for 2 guests. Your share is Rs.63."
    );
    await split.getByTestId("pos-close-split").click();

    // The guests are part of the table, so they come back after a reload.
    await page.reload({ waitUntil: "networkidle" });
    await page.getByLabel("Outlet").selectOption({ label: restaurant.name });
    await page.getByTestId("pos-table-T3").click();
    await expect(page.getByTestId("pos-lead-guest")).toContainText("Ramesh");
    await page.getByTestId("pos-open-split").click();
    await expect(page.getByTestId("pos-guest-name-2")).toHaveValue("Sunita");
  });

  test("adds and corrects a guest's number after the bill is paid", async ({ page }) => {
    const restaurant = await freshTerminal(page, "Fix number");
    await openTable(page, "T5");
    await addDishAndFire(page, PANEER);
    await page.getByTestId("pos-settle").click();
    await page.getByTestId("pos-confirm-settle").click();

    const receipt = page.getByRole("dialog", { name: "Bill" });
    await receipt.getByTestId("pos-receipt-add-guest").click();
    await receipt.getByTestId("pos-guest-edit-name").fill("Late Guest");
    await receipt.getByTestId("pos-guest-edit-phone").fill("91111 22222");
    await receipt.getByTestId("pos-guest-edit-save").click();

    await receipt.getByTestId("pos-receipt-edit-1").click();
    await receipt.getByTestId("pos-guest-edit-phone").fill("92222 33333");
    await receipt.getByTestId("pos-guest-edit-save").click();
    await receipt.getByTestId("pos-receipt-sms-1-open").click();
    expect(decodeURIComponent((await receipt.getByTestId("pos-receipt-sms-1").getAttribute("href")) ?? "")).toBe(
      `sms:+919222233333?&body=${restaurant.name}: Hi Late Guest, your bill for table T5 is Rs.252. Paid, thank you for visiting!`
    );
  });

  test("lets the owner fix a paid bill with the PIN, and staff fix the waiter's name", async ({ page }) => {
    const restaurant = await freshTerminal(page, "Owner fix");
    const pin = await page.request.post(`/api/owner/${restaurant.id}/pos-pin`, {
      data: { pin: "2468", password: STAFF_PASSWORD },
    });
    expect(pin.ok(), await pin.text()).toBe(true);

    await openTable(page, "T2");
    await page.getByTestId("pos-edit-server").click();
    await page.getByTestId("pos-server-input").fill("Ravi");
    await page.getByTestId("pos-server-save").click();
    await expect(page.getByTestId("pos-edit-server")).toContainText("Ravi");

    await addDishAndFire(page, PANEER);
    await page.getByTestId("pos-settle").click();
    await page.getByTestId("pos-confirm-settle").click();
    const receipt = page.getByRole("dialog", { name: "Bill" });
    await expect(receipt).toContainText("Server: Ravi");

    // Settled as cash by mistake: only the owner's PIN changes it.
    await receipt.getByTestId("pos-change-payment").click();
    const approval = page.getByRole("dialog", { name: "Change payment" });
    await approval.getByTestId("pos-owner-method-UPI").click();
    await approval.getByTestId("pos-owner-pin").fill("1111");
    await approval.getByTestId("pos-owner-confirm").click();
    await expect(approval).toContainText("Wrong owner PIN");
    await approval.getByTestId("pos-owner-pin").fill("2468");
    await approval.getByTestId("pos-owner-confirm").click();
    await expect(approval).toBeHidden();
    await expect(receipt.getByTestId("pos-receipt-corrections")).toContainText("Paid by CASH → UPI");

    // The guests ordered more after paying: the owner reopens the bill with a reason.
    await receipt.getByTestId("pos-reopen-bill").click();
    const reopen = page.getByRole("dialog", { name: "Reopen bill" });
    await reopen.getByTestId("pos-owner-reason").fill("Ordered more");
    await reopen.getByTestId("pos-owner-pin").fill("2468");
    await reopen.getByTestId("pos-owner-confirm").click();
    await expect(page.getByTestId("pos-table-T2")).not.toContainText("Free");
    await addDishAndFire(page, KARI_FULL);
    await expect(page.getByTestId("pos-grand-total")).toHaveText("₹378");
  });

  test("keeps every paid bill in Sales, searchable, and reopens any of them as a receipt", async ({ page }) => {
    // Two bills are rung up and paid over the network before Sales opens.
    test.slow();
    const restaurant = await freshTerminal(page, "Sales");
    await page.getByTestId("pos-table-T1").click();
    await page.getByTestId("pos-lead-guest-name").fill("Ramesh");
    await page.getByTestId("pos-lead-guest-phone").fill("98765 43210");
    await page.getByTestId("pos-confirm-open-table").click();
    await addDishAndFire(page, PANEER);
    await page.getByTestId("pos-settle").click();
    await page.getByTestId("pos-confirm-settle").click();
    await expect(page.getByTestId("pos-receipt-bill-number")).toHaveText("Bill No. 1", { timeout: 20_000 });
    await page.getByTestId("pos-close-receipt").click();

    await openTable(page, "T2");
    await addDishAndFire(page, KARI_FULL);
    await page.getByTestId("pos-settle").click();
    await page.getByTestId("pos-payment-UPI").click();
    await page.getByTestId("pos-confirm-settle").click();
    await expect(page.getByTestId("pos-receipt-bill-number")).toHaveText("Bill No. 2", { timeout: 20_000 });
    await page.getByTestId("pos-close-receipt").click();

    await page.getByTestId("pos-open-sales").click();
    const sales = page.getByRole("dialog", { name: "Sales history" });
    await expect(sales.getByTestId("sales-entry")).toHaveCount(2);
    await expect(sales.getByTestId("sales-summary")).toContainText("₹378");
    await expect(sales.getByTestId("sales-entry").first()).toContainText("#2");

    await sales.getByTestId("sales-search").fill("ramesh");
    await expect(sales.getByTestId("sales-entry")).toHaveCount(1);
    await sales.getByTestId("sales-entry").click();

    // A guest asks for their bill later: it reprints exactly, and can be texted to any number.
    const past = page.getByRole("dialog", { name: "Past bill" });
    await expect(past).toContainText("Bill No. 1");
    await expect(past).toContainText("Paneer Tikka");
    await past.getByTestId("sales-receipt-number").fill("91234 56789");
    await past.getByTestId("sales-receipt-sms-other-open").click();
    expect(decodeURIComponent((await past.getByTestId("sales-receipt-sms-other").getAttribute("href")) ?? "")).toBe(
      `sms:+919123456789?&body=${restaurant.name}: Hello, your bill for table T1 is Rs.252. Paid, thank you for visiting!`
    );
    await past.getByTestId("sales-receipt-close").click();

    await sales.getByTestId("sales-range-yesterday").click();
    await expect(sales).toContainText("No bills");
  });

  test("frees a table opened by mistake", async ({ page }) => {
    await freshTerminal(page, "Release");
    await openTable(page, "T4");
    await page.getByRole("button", { name: KARI_FULL }).click();
    await page.getByRole("button", { name: "Remove" }).click();
    await page.getByTestId("pos-release-table").click();
    await expect(page.getByTestId("pos-table-T4")).toContainText("Free");
  });

  test("merges one table into another and frees the source", async ({ page }) => {
    await freshTerminal(page, "Merge");
    await openTable(page, "T1");
    await addDishAndFire(page, PANEER);

    await openTable(page, "T2");
    await addDishAndFire(page, KARI_FULL);

    const select = page.getByTestId("pos-merge-select");
    await select.selectOption({ index: 1 });

    await expect(page.getByTestId("pos-table-T1")).toContainText("Free");
    await expect(page.getByTestId("pos-grand-total")).toHaveText("₹378");
    await expect(page.getByText(/Kitchen tickets \(2\)/)).toBeVisible();
  });

  test("settles a bill and closes a shift with a balanced Z-report", async ({ page }) => {
    await freshTerminal(page, "Shift");

    await page.getByTestId("pos-shift-control").click();
    await page.getByTestId("pos-confirm-shift").click();

    await openTable(page, "T3");
    await addDishAndFire(page, PANEER);

    await page.getByTestId("pos-settle").click();
    await page.getByTestId("pos-confirm-settle").click();
    await page.getByTestId("pos-close-receipt").click();

    await page.getByTestId("pos-shift-control").click();
    await page.getByTestId("pos-confirm-shift").click();

    const report = page.getByTestId("pos-z-report");
    await expect(report).toBeVisible();
    // Opening float plus the one cash bill was pre-filled, so the drawer must balance.
    await expect(page.getByTestId("pos-z-variance")).toHaveText("0.00");
    await expect(report).toContainText("Bills settled");
  });

  test("keeps billing with no network and reloads from the device", async ({ page, context }) => {
    const restaurant = await freshTerminal(page, "Offline");
    // Load the terminal once through the service worker, so its saved copy knows this outlet.
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.reload({ waitUntil: "networkidle" });
    await page.getByLabel("Outlet").selectOption({ label: restaurant.name });

    await openTable(page, "T4");
    await addDishAndFire(page, PANEER);

    await context.setOffline(true);
    try {
      await addDishAndFire(page, KARI_FULL);
      await expect(page.getByTestId("pos-grand-total")).toHaveText("₹378");

      // The cached shell plus the local queue must carry a full reload.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.getByLabel("Outlet").selectOption({ label: restaurant.name });
      await expect(page.getByTestId("pos-table-T4")).toContainText("₹378");
    } finally {
      await context.setOffline(false);
    }
  });

  test("syncs the floor to the account and recovers it after a wipe", async ({ page }) => {
    const restaurant = await freshTerminal(page, "Recovery");
    // The first push rewrites every table the shared staff account holds, over the network.
    await expect(page.getByTestId("pos-sync-status")).toContainText("Saved to", { timeout: 20_000 });

    await openTable(page, "T5");
    await addDishAndFire(page, PANEER);
    await expect.poll(async () => {
      const state = await (await page.request.get("/api/webroutes/pos/state")).json();
      return state.sessions.some(
        (session: { outletName: string; tableId: string }) =>
          session.outletName === restaurant.name && session.tableId === "T5"
      );
    }, { timeout: 15_000 }).toBe(true);

    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle" });
    await page.getByLabel("Outlet").selectOption({ label: restaurant.name });
    await expect(page.getByTestId("pos-table-T5")).toContainText("₹252");
  });

  test("refuses a stale write instead of overwriting a live table", async ({ page }) => {
    const restaurant = await freshTerminal(page, "Conflict");
    const { outletId, itemId } = await posIds(page, restaurant);
    const table = tableSession(outletId, restaurant.name, itemId);

    const first = await (
      await page.request.post("/api/webroutes/pos/sync", { data: { sessions: [table], shift: null } })
    ).json();
    const storedRevision = first.sessions.find(
      (session: { sessionId: string }) => session.sessionId === table.sessionId
    ).revision;

    const stale = { ...table, lines: [{ ...table.lines[0], quantity: 9 }], revision: 0 };
    const conflicted = await (
      await page.request.post("/api/webroutes/pos/sync", { data: { sessions: [stale], shift: null } })
    ).json();

    expect(conflicted.conflicts).toHaveLength(1);
    expect(conflicted.conflicts[0].reason).toContain("another terminal");
    const kept = conflicted.sessions.find(
      (session: { sessionId: string }) => session.sessionId === table.sessionId
    );
    expect(kept.lines[0].quantity).toBe(1);

    const fresh = { ...table, lines: [{ ...table.lines[0], quantity: 3 }], revision: storedRevision };
    const accepted = await (
      await page.request.post("/api/webroutes/pos/sync", { data: { sessions: [fresh], shift: null } })
    ).json();
    const saved = accepted.sessions.find(
      (session: { sessionId: string }) => session.sessionId === table.sessionId
    );
    expect(saved.lines[0].quantity).toBe(3);
  });

  test("reprices a tampered payload from the restaurant's menu", async ({ page }) => {
    const restaurant = await freshTerminal(page, "Reprice");
    const { outletId, itemId } = await posIds(page, restaurant);
    const base = tableSession(outletId, "Somewhere Else", itemId);
    const tampered = { ...base, lines: [{ ...base.lines[0], unitPrice: 1 }] };

    const result = await (
      await page.request.post("/api/webroutes/pos/sync", { data: { sessions: [tampered], shift: null } })
    ).json();
    const stored = result.sessions.find(
      (session: { sessionId: string }) => session.sessionId === tampered.sessionId
    );
    expect(stored.lines[0].unitPrice).toBe(240);
    // The bill carries the restaurant's own name, not the device's.
    expect(stored.outletName).toBe(restaurant.name);
  });

  test("keeps every tap when the next one lands while the last is still saving", async ({ page }) => {
    const restaurant = await freshTerminal(page, "Fast Taps");
    await expect(page.getByTestId("pos-sync-status")).toContainText("Saved to", { timeout: 20_000 });
    // A slow network: the server stores each push at once, but its answer takes a while.
    await page.route("**/api/webroutes/pos/sync", async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      await route.fulfill({ response });
    });

    const firstPush = page.waitForRequest("**/api/webroutes/pos/sync");
    await openTable(page, "T4");
    await page.getByRole("button", { name: PANEER }).click();
    await firstPush;
    // The waiter carries on while that first save is still on its way back.
    await page.getByRole("button", { name: KARI_FULL }).click();
    await expect(page.getByTestId("pos-grand-total")).toHaveText("₹378");

    await expect.poll(async () => {
      const state = await (await page.request.get("/api/webroutes/pos/state")).json();
      const table = state.sessions.find(
        (session: { outletName: string; tableId: string; status: string }) =>
          session.outletName === restaurant.name && session.tableId === "T4" && session.status === "OPEN"
      );
      return table?.lines.map((line: { name: string; quantity: number }) => `${line.quantity} ${line.name}`);
    }, { timeout: 20_000 }).toEqual(["1 Paneer Tikka", "1 Chicken Kari (Full)"]);
    await expect(page.getByTestId("pos-grand-total")).toHaveText("₹378");
    // Neither a conflict with itself nor anything left unsaved.
    await expect(page.getByText(/at the same time|Not saved|could not be saved|another terminal/)).toHaveCount(0);
  });

  test("shows one phone's table on another within seconds, both ways", async ({ page, browser }) => {
    const restaurant = await freshTerminal(page, "Two Phones");
    const otherContext = await browser.newContext();
    try {
      const other = await otherContext.newPage();
      await openTerminal(other, restaurant);
      await expect(page.getByTestId("pos-sync-status")).toContainText("Saved to", { timeout: 20_000 });
      await expect(other.getByTestId("pos-sync-status")).toContainText("Saved to", { timeout: 20_000 });

      await openTable(page, "T5");
      await addDishAndFire(page, PANEER);
      await expect(page.getByTestId("pos-grand-total")).toHaveText("₹252");
      // The other phone never reloads; its floor poll brings the table over.
      await expect(other.getByTestId("pos-table-T5")).toContainText("₹252", { timeout: 20_000 });

      await other.getByTestId("pos-table-T5").click();
      await addDishAndFire(other, KARI_FULL);
      await expect(other.getByTestId("pos-grand-total")).toHaveText("₹378");
      await expect(page.getByTestId("pos-grand-total")).toHaveText("₹378", { timeout: 20_000 });
      for (const phone of [page, other]) {
        await expect(phone.getByText(/at the same time|Not saved|could not be saved|another terminal/)).toHaveCount(0);
      }
    } finally {
      await otherContext.close();
    }
  });
});

test.describe("Terminal access control", () => {
  test("asks a signed-out browser to sign in and refuses it sync", async ({ page }) => {
    await resetBrowser(page, "/pos");
    await expect(page.getByTestId("pos-unavailable")).toContainText("Sign in to take table orders");

    expect((await page.request.get("/api/webroutes/pos/state")).status()).toBe(401);
    const sync = await page.request.post("/api/webroutes/pos/sync", {
      data: { sessions: [], shift: null },
    });
    expect(sync.status()).toBe(401);
  });

  test("bills only for the account's own restaurants", async ({ page }) => {
    const restaurant = await freshTerminal(page, "Guarded");
    const { outletId, itemId } = await posIds(page, restaurant);

    await page.request.post("/api/webroutes/auth/logout");
    await registerAccount(page, uniqueEmail("no-restaurant"), PASSWORD);
    await page.goto("/pos", { waitUntil: "networkidle" });
    await expect(page.getByTestId("pos-unavailable")).toContainText("No restaurant on this account yet");

    // Knowing another restaurant's outlet and dish ids is not enough to bill as it.
    const table = tableSession(outletId, restaurant.name, itemId);
    const result = await (
      await page.request.post("/api/webroutes/pos/sync", { data: { sessions: [table], shift: null } })
    ).json();
    expect(result.sessions).toEqual([]);
    expect(result.rejected).toEqual([
      { sessionId: table.sessionId, reason: `This account cannot bill for ${restaurant.name}.` },
    ]);
  });
});
