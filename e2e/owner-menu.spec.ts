import { expect, test, type APIRequestContext } from "@playwright/test";
import { registerAccount, resetBrowser, signInAsStaff, uniqueEmail } from "./helpers";

/**
 * The managed-restaurant journey for the one real restaurant: an approved owner creates it,
 * builds a menu by hand, publishes, and customers see only what was published. Storage and
 * the AI provider are deliberately unconfigured here (playwright.config.ts), so the suite
 * also proves those outages leave owners with a clear, working fallback.
 */

const SLUG = `jagadamba-e2e-${Date.now().toString(36)}`;
const NAME = "Jagadamba Maratha Khanawali";

async function ownerRestaurantId(request: APIRequestContext): Promise<string> {
  const response = await request.get("/api/owner");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { restaurants: Array<{ id: string; slug: string }> };
  const restaurant = body.restaurants.find((entry) => entry.slug === SLUG);
  expect(restaurant, "the owner should see the restaurant they created").toBeTruthy();
  return restaurant!.id;
}

/**
 * The root loading.tsx streams the shell before the page can call notFound(), so Next keeps
 * a 200 and marks the response noindex (a documented soft 404). What matters is that no
 * restaurant content leaks and crawlers are told not to index it.
 */
async function expectRestaurantHidden(request: APIRequestContext, path: string) {
  const response = await request.get(path);
  expect([200, 404]).toContain(response.status());
  const html = await response.text();
  expect(html).toMatch(/<meta name="robots" content="noindex"/);
  expect(html).toContain("This page could not be found");
  expect(html).not.toContain(NAME);
}

test.describe.serial("Owner menu workflow", () => {
  test("an approved owner creates the restaurant, builds a menu and publishes it", async ({ page }) => {
    await resetBrowser(page);
    await signInAsStaff(page);
    await page.goto("/owner");

    await expect(page.getByRole("heading", { name: `Create ${NAME}` })).toBeVisible();
    await page.getByLabel("Restaurant name").fill(NAME);
    await page.getByLabel("URL slug").fill(SLUG);
    await page.getByLabel("City").fill("Wadi");
    await page.getByLabel("State").fill("Karnataka");
    await page.getByRole("button", { name: "Save restaurant draft" }).click();
    await expect(page.getByRole("heading", { level: 2, name: NAME, exact: true })).toBeVisible();

    // Storage and AI are off in this environment: owners are told why, and the controls
    // that would fail are disabled instead of failing after a file is chosen.
    await expect(page.getByText("File storage is not configured on this server")).toBeVisible();
    await expect(page.getByLabel("Menu pages or PDF")).toBeDisabled();

    await page.getByLabel("New category name").fill("Biryani");
    await page.getByRole("button", { name: "Add category" }).click();
    await expect(page.getByRole("heading", { level: 3, name: "Biryani", exact: true })).toBeVisible();

    // A published dish.
    await page.getByLabel("Dish name", { exact: true }).fill("Chicken Biriyani");
    await page.getByLabel("Price (₹)", { exact: true }).fill("100");
    await page.getByLabel("Publish this dish").check();
    await page.getByRole("button", { name: "Add and publish dish" }).click();
    const published = page.getByRole("listitem").filter({ hasText: "Chicken Biriyani" });
    await expect(published).toContainText("Published · Available");

    // A draft that customers must never see.
    await page.getByLabel("Dish name", { exact: true }).fill("Unconfirmed Thali");
    await page.getByLabel("Price (₹)", { exact: true }).fill("90");
    await page.getByRole("button", { name: "Add dish as draft" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Unconfirmed Thali" })).toContainText("Draft");

    await page.getByRole("button", { name: "Publish restaurant" }).click();
    await expect(page.getByRole("button", { name: "Unpublish restaurant" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Preview customer page" })).toBeVisible();
  });

  test("customers see only published dishes on the public page", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const response = await page.goto(`/r/${SLUG}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: NAME, exact: true })).toBeVisible();
    await expect(page.getByText("Chicken Biriyani")).toBeVisible();
    await expect(page.getByText(/₹\s?100(\.00)?$/).first()).toBeVisible();
    await expect(page.getByText("Unconfirmed Thali")).toHaveCount(0);
    await context.close();
  });

  test("owner corrects a price, toggles availability and deletes a draft from the list", async ({ browser, page }) => {
    await signInAsStaff(page);
    await page.goto("/owner");
    await expect(page.getByRole("heading", { level: 2, name: NAME, exact: true })).toBeVisible();

    // Correcting a price goes through the revision check; a stale form would get a 409.
    await page.getByRole("button", { name: "Edit Chicken Biriyani" }).click();
    await expect(page.getByLabel("Dish name", { exact: true })).toBeFocused();
    await page.getByLabel("Price (₹)", { exact: true }).fill("120");
    await page.getByRole("button", { name: "Save dish" }).click();
    const biryani = page.getByRole("listitem").filter({ hasText: "Chicken Biriyani" });
    await expect(biryani).toContainText("₹120");

    await page.getByLabel("Search dishes").fill("thali");
    await expect(page.getByRole("listitem").filter({ hasText: "Chicken Biriyani" })).toHaveCount(0);
    await expect(page.getByText("1 of 2 dishes")).toBeVisible();
    await page.getByLabel("Search dishes").fill("");

    await page.getByRole("button", { name: "Mark unavailable: Chicken Biriyani" }).click();
    await expect(biryani).toContainText("Published · Unavailable");

    const customer = await browser.newContext();
    const publicPage = await customer.newPage();
    await publicPage.goto(`/r/${SLUG}`);
    await expect(publicPage.getByText("Chicken Biriyani")).toHaveCount(0);

    await page.getByRole("button", { name: "Mark available: Chicken Biriyani" }).click();
    await expect(biryani).toContainText("Published · Available");
    await publicPage.reload();
    await expect(publicPage.getByText("Chicken Biriyani")).toBeVisible();
    await expect(publicPage.getByText(/₹\s?120(\.00)?$/).first()).toBeVisible();
    await customer.close();

    // Deleting asks first; "Keep dish" leaves it alone.
    await page.getByRole("button", { name: "Delete Unconfirmed Thali" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete dish" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Keep dish" }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("listitem").filter({ hasText: "Unconfirmed Thali" })).toHaveCount(1);

    await page.getByRole("button", { name: "Delete Unconfirmed Thali" }).click();
    await dialog.getByRole("button", { name: "Delete dish" }).click();
    await expect(page.getByRole("listitem").filter({ hasText: "Unconfirmed Thali" })).toHaveCount(0);
  });

  test("a stale availability toggle is refused with 409", async ({ page }) => {
    await signInAsStaff(page);
    const id = await ownerRestaurantId(page.request);
    const menu = await (await page.request.get(`/api/owner/${id}/menu`)).json();
    const item = menu.categories.flatMap((c: { items: { id: string; name: string; revision: number }[] }) => c.items)
      .find((i: { name: string }) => i.name === "Chicken Biriyani");
    const stale = await page.request.patch(`/api/owner/${id}/menu`, {
      data: { type: "itemAvailability", id: item.id, available: true, revision: item.revision - 1 },
    });
    expect(stale.status()).toBe(409);
    const missing = await page.request.patch(`/api/owner/${id}/menu`, {
      data: { type: "itemAvailability", id: "no-such-dish", available: true, revision: 1 },
    });
    expect(missing.status()).toBe(400);
  });

  test("request payloads cannot escalate status or ownership", async ({ page }) => {
    await signInAsStaff(page);
    const id = await ownerRestaurantId(page.request);
    const unpublished = await page.request.post(`/api/owner/${id}`, { data: { action: "unpublish" } });
    expect(unpublished.ok(), await unpublished.text()).toBe(true);

    const patched = await page.request.patch(`/api/owner/${id}`, {
      data: { status: "published", ownerUserId: "someone-else", publishedAt: "2020-01-01T00:00:00Z" },
    });
    expect(patched.ok()).toBe(true);
    const restaurant = (await patched.json()).restaurant as { status: string };
    expect(restaurant.status).toBe("draft");

    await expectRestaurantHidden(page.request, `/r/${SLUG}`);

    // Restore the published state for the remaining specs.
    const republished = await page.request.post(`/api/owner/${id}`, { data: { action: "publish" } });
    expect(republished.ok()).toBe(true);
  });

  test("another account cannot read or change the owner's restaurant", async ({ browser, page }) => {
    await signInAsStaff(page);
    const id = await ownerRestaurantId(page.request);

    const context = await browser.newContext();
    const intruder = await context.newPage();
    await resetBrowser(intruder);
    await registerAccount(intruder, uniqueEmail("intruder"), "e2e-intruder-password");

    const reads = [
      intruder.request.get(`/api/owner/${id}`),
      intruder.request.get(`/api/owner/${id}/menu`),
      intruder.request.get(`/api/owner/${id}/imports`),
      intruder.request.get(`/api/owner/${id}/assets?assetId=anything`),
    ];
    for (const response of await Promise.all(reads)) expect(response.status()).toBe(403);

    const writes = [
      intruder.request.patch(`/api/owner/${id}`, { data: { name: "Taken over" } }),
      intruder.request.post(`/api/owner/${id}`, { data: { action: "unpublish" } }),
      intruder.request.post(`/api/owner/${id}/menu`, { data: { type: "category", name: "Injected" } }),
      intruder.request.delete(`/api/owner/${id}/menu?categoryId=anything`),
      intruder.request.patch(`/api/owner/${id}/menu`, { data: { type: "itemAvailability", id: "x", available: false, revision: 1 } }),
      intruder.request.post("/api/owner", { data: { name: "Rogue", slug: "rogue-restaurant" } }),
    ];
    for (const response of await Promise.all(writes)) expect(response.status()).toBe(403);

    const overview = await intruder.request.get("/api/owner");
    expect((await overview.json()).restaurants).toEqual([]);
    await context.close();

    const anonymous = await browser.newContext();
    const unauthenticated = await anonymous.request.get(`/api/owner/${id}`);
    expect(unauthenticated.status()).toBe(401);
    await anonymous.close();

    // The owner's restaurant is untouched.
    const after = await page.request.get(`/api/owner/${id}`);
    expect((await after.json()).restaurant.name).toBe(NAME);
  });

  test("owner mutations refuse cross-site requests and malformed bodies", async ({ page }) => {
    await signInAsStaff(page);
    const id = await ownerRestaurantId(page.request);

    const crossSite = await page.request.patch(`/api/owner/${id}`, {
      headers: { origin: "https://attacker.example" },
      data: { name: "Forged" },
    });
    expect(crossSite.status()).toBe(403);

    const malformed = await page.request.patch(`/api/owner/${id}`, {
      headers: { "content-type": "application/json" },
      data: "{not json",
    });
    expect(malformed.status()).toBe(400);

    const upload = await page.request.post(`/api/owner/${id}/uploads`, {
      multipart: {
        kind: "menu_document",
        file: { name: "menu.png", mimeType: "image/png", buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      },
    });
    expect(upload.status()).toBe(503);
    expect((await upload.json()).message).toContain("File storage is not configured");

    const after = await page.request.get(`/api/owner/${id}`);
    expect((await after.json()).restaurant.name).toBe(NAME);
  });

  test("an unknown restaurant slug shows not-found, not an error page", async ({ page }) => {
    await expectRestaurantHidden(page.request, "/r/no-such-restaurant");
    await expectRestaurantHidden(page.request, "/r/Not_A_Valid_Slug");
  });

  test("health reports a live database and the features this deployment lacks", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.checks).toEqual({ database: { status: "ok" }, schema: { status: "ok" } });
    expect(body.features).toMatchObject({ uploads: false, menuImport: false });
  });
});
