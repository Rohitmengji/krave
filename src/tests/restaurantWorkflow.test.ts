import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerUser } from "@/lib/server/auth";
import { run } from "@/lib/server/pg";
import {
  changeRestaurantPublication,
  MENU_ITEM_CONFLICT,
  claimMenuExtraction,
  createMenuCategory,
  getManagedMenu,
  getPublishedRestaurantBySlug,
  saveMenuItem,
  setMenuItemAvailability,
  updateMenuCategory,
} from "@/lib/server/restaurantStore";
import {
  hasTestDatabase,
  resetTestDatabase,
  startTestDatabase,
  stopTestDatabase,
} from "./support/testDb";

describe.skipIf(!hasTestDatabase)("restaurant owner workflow", () => {
  beforeAll(startTestDatabase);
  afterAll(stopTestDatabase);
  beforeEach(resetTestDatabase);

  async function createOwner(email = "owner@jagadamba.test") {
    return registerUser({
      email,
      password: "135790",
    });
  }

  async function createRestaurant(ownerId: string, id = "rst_jagadamba") {
    const now = new Date().toISOString();
    await run(
      `INSERT INTO managed_restaurants
       (id, owner_user_id, slug, name, created_at, updated_at)
       VALUES ($1, $2, $3, 'Jagadamba Maratha Khanawali', $4, $4)`,
      [id, ownerId, id === "rst_jagadamba" ? "jagadamba-maratha-khanawali" : id, now]
    );
    await run(
      `INSERT INTO restaurant_memberships (restaurant_id, user_id, role, granted_at, granted_by)
       VALUES ($1, $2, 'owner', $3, $2)`,
      [id, ownerId, now]
    );
    return id;
  }

  it("prevents one owner from reading another restaurant's menu", async () => {
    const owner = await createOwner();
    const other = await createOwner("other@jagadamba.test");
    const restaurantId = await createRestaurant(owner.id);

    await expect(getManagedMenu(other.id, restaurantId)).rejects.toThrow(/do not have access/i);
  });

  it("claims an extraction job only once under concurrent retries", async () => {
    const owner = await createOwner();
    const restaurantId = await createRestaurant(owner.id);
    const now = new Date().toISOString();
    await run(
      `INSERT INTO restaurant_assets
       (id, restaurant_id, uploaded_by, object_key, kind, file_name, mime_type, byte_size, created_at)
       VALUES ('ast_menu', $1, $2, 'test/menu.pdf', 'menu_document', 'menu.pdf',
         'application/pdf', 5, $3)`,
      [restaurantId, owner.id, now]
    );
    await run(
      `INSERT INTO menu_import_jobs
       (id, restaurant_id, source_asset_id, requested_by, status, created_at, updated_at)
       VALUES ('imp_menu', $1, 'ast_menu', $2, 'uploaded', $3, $3)`,
      [restaurantId, owner.id, now]
    );

    const results = await Promise.all([
      claimMenuExtraction(owner.id, restaurantId, "imp_menu"),
      claimMenuExtraction(owner.id, restaurantId, "imp_menu"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    await run("UPDATE menu_import_jobs SET updated_at = $1 WHERE id = 'imp_menu'", [
      new Date(Date.now() - 6 * 60_000).toISOString(),
    ]);
    await expect(claimMenuExtraction(owner.id, restaurantId, "imp_menu")).resolves.toBe(true);
  });

  it("keeps drafts private and exposes only published available menu items", async () => {
    const owner = await createOwner();
    const restaurantId = await createRestaurant(owner.id);
    const category = await createMenuCategory(owner.id, restaurantId, { name: "Meals" });
    const draft = await saveMenuItem(owner.id, restaurantId, {
      categoryId: category.id,
      name: "Jowar Roti Meal",
      pricePaise: 12_500,
    });

    expect(await getManagedMenu("", restaurantId, true)).toEqual([]);
    await saveMenuItem(owner.id, restaurantId, {
      id: draft.id,
      revision: draft.revision,
      categoryId: category.id,
      name: "Jowar Roti Meal",
      pricePaise: 12_500,
      published: true,
      available: true,
    });
    await changeRestaurantPublication(owner.id, restaurantId, true);

    const publishedRestaurant = await getPublishedRestaurantBySlug("jagadamba-maratha-khanawali");
    const publicMenu = await getManagedMenu("", restaurantId, true);
    expect(publishedRestaurant?.id).toBe(restaurantId);
    expect(publicMenu.flatMap((entry) => entry.items).map((item) => item.name)).toEqual([
      "Jowar Roti Meal",
    ]);

    // Unpublishing clears published_at but must still stamp updated_at (NOT NULL).
    const unpublished = await changeRestaurantPublication(owner.id, restaurantId, false);
    expect(unpublished.status).toBe("draft");
    expect(unpublished.publishedAt).toBeNull();
    expect(await getPublishedRestaurantBySlug("jagadamba-maratha-khanawali")).toBeNull();
  });

  it("refuses a save based on a stale revision so concurrent edits cannot overwrite each other", async () => {
    const owner = await createOwner();
    const restaurantId = await createRestaurant(owner.id);
    const category = await createMenuCategory(owner.id, restaurantId, { name: "Biryani" });
    const created = await saveMenuItem(owner.id, restaurantId, {
      categoryId: category.id,
      name: "Chicken Biriyani",
      pricePaise: 10_000,
    });
    expect(created.revision).toBe(1);

    const edit = (pricePaise: number) =>
      saveMenuItem(owner.id, restaurantId, {
        id: created.id,
        revision: created.revision,
        categoryId: category.id,
        name: "Chicken Biriyani",
        pricePaise,
      });
    // Two devices open the same revision and save at once: exactly one may win.
    const results = await Promise.allSettled([edit(11_000), edit(12_000)]);
    const won = results.filter((result) => result.status === "fulfilled");
    const lost = results.filter((result) => result.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason.message).toBe(MENU_ITEM_CONFLICT);

    const [saved] = (await getManagedMenu(owner.id, restaurantId)).flatMap((entry) => entry.items);
    expect(saved.revision).toBe(2);
    expect(saved.pricePaise).toBe((won[0] as PromiseFulfilledResult<{ pricePaise: number }>).value.pricePaise);

    await expect(
      saveMenuItem(owner.id, restaurantId, {
        id: created.id,
        categoryId: category.id,
        name: "Chicken Biriyani",
        pricePaise: 9_000,
      })
    ).rejects.toThrow(/Revision/);
  });

  it("toggles availability only against the current revision and never across restaurants", async () => {
    const owner = await createOwner();
    const restaurantId = await createRestaurant(owner.id);
    const category = await createMenuCategory(owner.id, restaurantId, { name: "Meals" });
    const item = await saveMenuItem(owner.id, restaurantId, { categoryId: category.id, name: "Thali", pricePaise: 9_000 });

    const toggled = await setMenuItemAvailability(owner.id, restaurantId, { id: item.id, available: false, revision: 1 });
    expect(toggled).toEqual({ id: item.id, available: false, revision: 2 });
    await expect(
      setMenuItemAvailability(owner.id, restaurantId, { id: item.id, available: true, revision: 1 })
    ).rejects.toThrow(MENU_ITEM_CONFLICT);
    await expect(
      setMenuItemAvailability(owner.id, restaurantId, { id: item.id, available: "yes", revision: 2 })
    ).rejects.toThrow();

    // A full edit opened before the toggle is now stale too.
    await expect(
      saveMenuItem(owner.id, restaurantId, { id: item.id, revision: 1, categoryId: category.id, name: "Thali", pricePaise: 9_500 })
    ).rejects.toThrow(MENU_ITEM_CONFLICT);

    const other = await createOwner("other-owner@jagadamba.test");
    const otherRestaurant = await createRestaurant(other.id, "rst_other");
    await expect(
      setMenuItemAvailability(other.id, otherRestaurant, { id: item.id, available: true, revision: 2 })
    ).rejects.toThrow(/not found/);
    await expect(
      setMenuItemAvailability(other.id, restaurantId, { id: item.id, available: true, revision: 2 })
    ).rejects.toThrow(/do not have access/);
    const [saved] = (await getManagedMenu(owner.id, restaurantId)).flatMap((entry) => entry.items);
    expect(saved.available).toBe(false);
  });

  it("rejects non-boolean category visibility instead of silently hiding it", async () => {
    const owner = await createOwner();
    const restaurantId = await createRestaurant(owner.id);
    const category = await createMenuCategory(owner.id, restaurantId, { name: "Meals" });

    await expect(
      updateMenuCategory(owner.id, restaurantId, category.id, { visible: "false" })
    ).rejects.toThrow(/visibility must be true or false/i);
  });
});
