import { expect, test } from "@playwright/test";
import { addDishAndFire, openTable, registerAccount, resetBrowser, uniqueEmail } from "./helpers";

const PASSWORD = "e2e-demo-password";
const KAJU = /Royal Kaju Katli Reserve/;
const KACHORI = /Royal Raj Kachori/;

test.describe("Dine-in terminal", () => {
  test("opens a table, fires a ticket, and reprints what the kitchen received", async ({ page }) => {
    await resetBrowser(page, "/pos");
    await openTable(page, "T1");
    await addDishAndFire(page, KAJU);

    await expect(page.getByTestId("pos-grand-total")).toHaveText("₹609");

    // Void the item, then confirm the reprint still shows it.
    await page.getByRole("button", { name: "Void" }).click();
    await page.getByRole("textbox").last().fill("Guest changed order");
    await page.getByRole("button", { name: "Void Item" }).click();

    await page.getByText(/Kitchen tickets/).click();
    await page.getByTestId("pos-reprint-kot-1").click();
    const ticket = page.getByRole("dialog", { name: "Kitchen ticket" });
    await expect(ticket).toContainText("REPRINT");
    await expect(ticket).toContainText("Royal Kaju Katli Reserve");
  });

  test("merges one table into another and frees the source", async ({ page }) => {
    await resetBrowser(page, "/pos");
    await openTable(page, "T1");
    await addDishAndFire(page, KAJU);

    await openTable(page, "T2");
    await addDishAndFire(page, KACHORI);

    const select = page.getByTestId("pos-merge-select");
    await select.selectOption({ index: 1 });

    await expect(page.getByTestId("pos-table-T1")).toContainText("Free");
    await expect(page.getByTestId("pos-grand-total")).toHaveText("₹835");
    await expect(page.getByText(/Kitchen tickets \(2\)/)).toBeVisible();
  });

  test("settles a bill and closes a shift with a balanced Z-report", async ({ page }) => {
    await resetBrowser(page, "/pos");

    await page.getByTestId("pos-shift-control").click();
    await page.getByTestId("pos-confirm-shift").click();

    await openTable(page, "T3");
    await addDishAndFire(page, KAJU);

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
    await resetBrowser(page, "/pos");
    await openTable(page, "T4");
    await addDishAndFire(page, KAJU);

    await context.setOffline(true);
    await addDishAndFire(page, KACHORI);
    await expect(page.getByTestId("pos-grand-total")).toHaveText("₹835");

    // The cached shell plus the local queue must carry a full reload.
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("pos-table-T4")).toContainText("₹835");

    await context.setOffline(false);
  });

  test("syncs the floor to an account and recovers it after a wipe", async ({ page }) => {
    await resetBrowser(page, "/pos");
    await registerAccount(page, uniqueEmail("terminal"), PASSWORD);
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByTestId("pos-sync-status")).toContainText("Saved to");

    await openTable(page, "T5");
    await addDishAndFire(page, KAJU);
    await expect.poll(async () => {
      const state = await page.request.get("/api/webroutes/pos/state");
      return (await state.json()).sessions.length;
    }, { timeout: 15_000 }).toBe(1);

    await page.evaluate(() => localStorage.clear());
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.getByTestId("pos-table-T5")).toContainText("₹609");
  });

  test("refuses a stale write instead of overwriting a live table", async ({ page }) => {
    await resetBrowser(page, "/pos");
    await registerAccount(page, uniqueEmail("conflict"), PASSWORD);

    const table = {
      sessionId: `POS-${crypto.randomUUID()}`,
      outletId: 19677790,
      outletName: "Mithaas Heritage & Sweets",
      tableId: "T1",
      guestCount: 2,
      serverName: "Asha",
      openedAt: new Date().toISOString(),
      status: "OPEN",
      lines: [
        {
          lineId: "L-1",
          itemId: "ctl_820099425",
          name: "Ghee Assorted Sweets Box",
          unitPrice: 732,
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
          lines: [{ name: "Ghee Assorted Sweets Box", quantity: 1, note: "", dietary: "veg" }],
        },
      ],
      mergedIntoSessionId: null,
      revision: 0,
    };

    const first = await (
      await page.request.post("/api/webroutes/pos/sync", { data: { sessions: [table], shift: null } })
    ).json();
    const storedRevision = first.sessions[0].revision;

    const stale = { ...table, lines: [{ ...table.lines[0], quantity: 9 }], revision: 0 };
    const conflicted = await (
      await page.request.post("/api/webroutes/pos/sync", { data: { sessions: [stale], shift: null } })
    ).json();

    expect(conflicted.conflicts).toHaveLength(1);
    expect(conflicted.conflicts[0].reason).toContain("another terminal");
    expect(conflicted.sessions[0].lines[0].quantity).toBe(1);

    const fresh = { ...table, lines: [{ ...table.lines[0], quantity: 3 }], revision: storedRevision };
    const accepted = await (
      await page.request.post("/api/webroutes/pos/sync", { data: { sessions: [fresh], shift: null } })
    ).json();
    expect(accepted.sessions[0].lines[0].quantity).toBe(3);
  });

  test("reprices a tampered terminal payload from the catalog", async ({ page }) => {
    await resetBrowser(page, "/pos");
    await registerAccount(page, uniqueEmail("reprice"), PASSWORD);

    const tampered = {
      sessionId: `POS-${crypto.randomUUID()}`,
      outletId: 19677790,
      outletName: "Mithaas Heritage & Sweets",
      tableId: "G1",
      guestCount: 2,
      serverName: "Asha",
      openedAt: new Date().toISOString(),
      status: "OPEN",
      lines: [
        {
          lineId: "L-9",
          itemId: "ctl_820099425",
          name: "Ghee Assorted Sweets Box",
          unitPrice: 1,
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
      tickets: [],
      mergedIntoSessionId: null,
      revision: 0,
    };

    const result = await (
      await page.request.post("/api/webroutes/pos/sync", {
        data: { sessions: [tampered], shift: null },
      })
    ).json();
    expect(result.sessions[0].lines[0].unitPrice).toBe(732);
  });
});

test.describe("Terminal access control", () => {
  test("refuses terminal sync to a signed-out browser", async ({ page }) => {
    await resetBrowser(page, "/pos");

    expect((await page.request.get("/api/webroutes/pos/state")).status()).toBe(401);
    const sync = await page.request.post("/api/webroutes/pos/sync", {
      data: { sessions: [], shift: null },
    });
    expect(sync.status()).toBe(401);
  });
});
