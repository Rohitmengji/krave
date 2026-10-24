import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { registerUser } from "@/lib/server/auth";
import { one, run, transaction } from "@/lib/server/pg";
import { listPosOutlets, loadPosPriceBook } from "@/lib/server/posCatalog";
import { getPublishedRestaurantBySlug } from "@/lib/server/restaurantStore";
import { parseSeedMenu, readSeedMenu, seedJagadamba } from "../../scripts/seed-jagadamba.mjs";
import {
  hasTestDatabase,
  resetTestDatabase,
  startTestDatabase,
  stopTestDatabase,
} from "./support/testDb";

const SLUG = "jagadamba-maratha-khanawali";
const DISH_COUNT = 31;

/** The parsed shape; the script is plain JavaScript, so its return type is not inferred. */
interface SeedMenu {
  restaurant: Record<string, unknown>;
  categories: {
    name: string;
    items: { name: string; pricePaise: number; variants: { name: string; priceDeltaPaise: number }[] }[];
  }[];
}

function menuWith(items: unknown[], categories: unknown[] = [{ name: "Meals", items }]) {
  return { restaurant: { slug: "test-kitchen", name: "Test Kitchen" }, categories };
}

describe("Jagadamba menu file", () => {
  it("holds every dish from the boards, priced in paise with the cheapest portion as the base", () => {
    const menu: SeedMenu = readSeedMenu();
    const dishes = menu.categories.flatMap((category) => category.items);
    expect(menu.restaurant).toMatchObject({ slug: SLUG, city: "Wadi", postalCode: "585225", deliveryEnabled: false });
    expect(menu.categories).toHaveLength(8);
    expect(dishes).toHaveLength(DISH_COUNT);

    const dish = (name: string) => dishes.find((candidate) => candidate.name === name);
    expect(dish("Mutton Biriyani")).toMatchObject({
      pricePaise: 12_000,
      variants: [
        { name: "Half", priceDeltaPaise: 0 },
        { name: "Full", priceDeltaPaise: 8_000 },
      ],
    });
    expect(dish("Fish Fry")?.variants.map((variant) => variant.priceDeltaPaise)).toEqual([0, 3_000, 5_000]);
    expect(dish("Chicken 65")).toMatchObject({ pricePaise: 5_000, variants: [], portionSize: "1 plate" });
    // Where the hand-painted veg board disagrees, the printed board's price is used.
    expect(dish("Roti")?.pricePaise).toBe(1_000);
    expect(dish("Chapati")?.pricePaise).toBe(1_200);
    expect(dish("Jeera Rice")).toMatchObject({ pricePaise: 4_000, variants: [{}, { priceDeltaPaise: 2_000 }] });
  });

  it("refuses a file with a mistake before anything is written", () => {
    expect(parseSeedMenu(menuWith([{ name: "Thali", rupees: 90 }])).categories[0].items[0].pricePaise).toBe(9_000);

    for (const rupees of [0, -5, 12.5, "10", 100_001, Number.NaN]) {
      expect(() => parseSeedMenu(menuWith([{ name: "Thali", rupees }])), String(rupees)).toThrow(
        /whole number of rupees/
      );
    }
    expect(() => parseSeedMenu(menuWith([{ name: "Thali" }]))).toThrow(/has no price/);
    expect(() => parseSeedMenu(menuWith([{ name: "  ", rupees: 90 }]))).toThrow(/Dish name/);
    expect(() => parseSeedMenu(menuWith([{ name: "Thali", variants: [["Half", 60]] }]))).toThrow(
      /two or more portions/
    );
    expect(() =>
      parseSeedMenu(menuWith([{ name: "Thali", variants: [["Full", 100], ["Half", 60]] }]))
    ).toThrow(/cheapest portion first/);
    expect(() => parseSeedMenu(menuWith([{ name: "Thali", rupees: 90, dietary: ["halal"] }]))).toThrow(
      /unknown dietary tag/
    );
    expect(() =>
      parseSeedMenu(
        menuWith([], [
          { name: "Meals", items: [{ name: "Thali", rupees: 90 }] },
          { name: "Specials", items: [{ name: "THALI", rupees: 120 }] },
        ])
      )
    ).toThrow(/listed twice/);
    expect(() => parseSeedMenu(menuWith([]))).toThrow(/at least one dish/);
    expect(() =>
      parseSeedMenu({ ...menuWith([{ name: "Thali", rupees: 90 }]), restaurant: { slug: "Test Kitchen", name: "T" } })
    ).toThrow(/Slug/);
  });
});

describe.skipIf(!hasTestDatabase)("seeding a restaurant and loading it at the terminal", () => {
  beforeAll(startTestDatabase);
  afterAll(stopTestDatabase);
  beforeEach(resetTestDatabase);

  const OWNER = { email: "owner@jagadamba.test", password: "135790" };
  const seed = (options: { ownerEmail: string; publish?: boolean }) =>
    transaction((client) => seedJagadamba(client, options));
  const count = async (table: string) =>
    (await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`))?.n;

  it("creates a draft restaurant run by the owner, then adds nothing on a rerun", async () => {
    const owner = await registerUser(OWNER);
    const first = await seed({ ownerEmail: "  Owner@Jagadamba.TEST " });
    expect(first).toMatchObject({ slug: SLUG, createdRestaurant: true, published: false });
    expect(first.created).toHaveLength(DISH_COUNT);
    expect(await getPublishedRestaurantBySlug(SLUG)).toBeNull();
    expect(await one("SELECT role FROM restaurant_memberships WHERE user_id = $1", [owner.id])).toEqual({
      role: "owner",
    });

    const again = await seed({ ownerEmail: OWNER.email });
    expect(again).toMatchObject({ createdRestaurant: false, created: [], published: false });
    expect(again.skipped).toHaveLength(DISH_COUNT);
    expect(await count("menu_items")).toBe(DISH_COUNT);
    expect(await count("menu_categories")).toBe(8);
  });

  it("keeps the owner's later edits and only restores a dish that was deleted", async () => {
    await registerUser(OWNER);
    await seed({ ownerEmail: OWNER.email });
    await run("UPDATE menu_items SET price_paise = 7000 WHERE name = 'Chicken Biriyani'");
    await run("DELETE FROM menu_items WHERE name = 'Papad'");

    const rerun = await seed({ ownerEmail: OWNER.email });
    expect(rerun.created).toEqual(["Papad"]);
    expect(await one("SELECT price_paise FROM menu_items WHERE name = 'Chicken Biriyani'")).toEqual({
      price_paise: 7000,
    });
    expect(await count("menu_categories")).toBe(8);
  });

  it("changes nothing for an unknown owner or someone outside the restaurant's team", async () => {
    await expect(seed({ ownerEmail: "" })).rejects.toThrow(/owner-email/);
    await expect(seed({ ownerEmail: "nobody@jagadamba.test" })).rejects.toThrow(/No account/);
    expect(await count("managed_restaurants")).toBe(0);

    await registerUser(OWNER);
    await seed({ ownerEmail: OWNER.email });
    await run("DELETE FROM menu_items WHERE name = 'Papad'");
    await registerUser({ ...OWNER, email: "stranger@jagadamba.test" });
    await expect(seed({ ownerEmail: "stranger@jagadamba.test" })).rejects.toThrow(/not on its team/);
    expect(await count("menu_items")).toBe(DISH_COUNT - 1);
  });

  it("serialises two runs at once so nothing is created twice", async () => {
    await registerUser(OWNER);
    const results = await Promise.all([seed({ ownerEmail: OWNER.email }), seed({ ownerEmail: OWNER.email })]);
    expect(results.map((result) => result.created.length).sort()).toEqual([0, DISH_COUNT]);
    expect(await count("managed_restaurants")).toBe(1);
    expect(await count("menu_items")).toBe(DISH_COUNT);
  });

  it("publishes only when asked, and only with a dish customers can order", async () => {
    await registerUser(OWNER);
    const hidden = await seed({ ownerEmail: OWNER.email });
    expect(hidden.published).toBe(false);
    await run("UPDATE menu_items SET available = 0");
    expect((await seed({ ownerEmail: OWNER.email, publish: true })).published).toBe(false);
    expect(await getPublishedRestaurantBySlug(SLUG)).toBeNull();

    await run("UPDATE menu_items SET available = 1");
    expect((await seed({ ownerEmail: OWNER.email, publish: true })).published).toBe(true);
    expect((await getPublishedRestaurantBySlug(SLUG))?.name).toBe("Jagadamba Maratha Khanawali");
  });

  it("rings up each portion as its own item at the price customers pay", async () => {
    const owner = await registerUser(OWNER);
    await seed({ ownerEmail: OWNER.email });
    await run("UPDATE menu_items SET discounted_price_paise = 4500 WHERE name = 'Chicken 65'");

    const outlets = await listPosOutlets(owner.id);
    expect(outlets).toHaveLength(1);
    const [outlet] = outlets;
    expect(outlet).toMatchObject({ name: "Jagadamba Maratha Khanawali", locality: "Wadi" });
    // 21 dishes with two portions, Fish Fry with three, and 9 sold as one.
    expect(outlet.menu).toHaveLength(54);
    expect(new Set(outlet.menu.map((item) => item.itemId)).size).toBe(54);

    const item = (name: string) => outlet.menu.find((candidate) => candidate.name === name);
    expect(item("Mutton Biriyani (Half)")).toMatchObject({ price: 120, dietary: "non-veg", categoryName: "Biryani & Rice" });
    expect(item("Mutton Biriyani (Full)")?.price).toBe(200);
    expect(item("Fish Fry (3 pieces)")?.price).toBe(80);
    expect(item("Egg Kari (Full)")).toMatchObject({ price: 50, dietary: "egg" });
    expect(item("Chapati")).toMatchObject({ price: 12, dietary: "veg" });
    expect(item("Chicken 65")?.price).toBe(45);
    // Nothing declared, so the counter must not call it vegetarian.
    expect(item("Solai (Half)")?.dietary).toBe("non-veg");
  });

  it("offers only what a guest can order now, and never a price it would have to round", async () => {
    const owner = await registerUser(OWNER);
    await seed({ ownerEmail: OWNER.email });
    await run("UPDATE menu_items SET available = 0 WHERE name = 'Papad'");
    await run("UPDATE menu_items SET published = 0 WHERE name = 'Curd'");
    await run("UPDATE menu_categories SET visible = 0 WHERE name = 'Fish'");
    await run(
      `UPDATE menu_item_variants SET available = 0
       WHERE name = 'Full' AND item_id = (SELECT id FROM menu_items WHERE name = 'Mutton Fry')`
    );
    await run("UPDATE menu_items SET price_paise = 1550 WHERE name = 'Parota'");

    const [outlet] = await listPosOutlets(owner.id);
    const names = outlet.menu.map((entry) => entry.name);
    expect(names).not.toContain("Papad");
    expect(names).not.toContain("Curd");
    expect(names.some((name) => name.startsWith("Fish Fry"))).toBe(false);
    expect(names).toContain("Mutton Fry (Half)");
    expect(names).not.toContain("Mutton Fry (Full)");
    expect(names).not.toContain("Parota");

    // A bill already holding a dish that was then hidden can still be priced; ₹15.50 cannot.
    const prices = await loadPosPriceBook(owner.id);
    const idOf = async (name: string) =>
      (await one<{ id: string }>("SELECT id FROM menu_items WHERE name = $1", [name]))!.id;
    expect(prices.priceOf(outlet.outletId, await idOf("Papad"))).toBe(5);
    expect(prices.priceOf(outlet.outletId, await idOf("Parota"))).toBeNull();
    expect(prices.priceOf(outlet.outletId + 1, await idOf("Roti"))).toBeNull();
    expect(prices.outlets).toEqual(new Map([[outlet.outletId, "Jagadamba Maratha Khanawali"]]));
  });

  it("lets only the restaurant's team bill for it, and nobody while it is suspended", async () => {
    const owner = await registerUser(OWNER);
    const waiter = await registerUser({ ...OWNER, email: "waiter@jagadamba.test" });
    const { restaurantId } = await seed({ ownerEmail: OWNER.email });

    expect(await listPosOutlets(waiter.id)).toEqual([]);
    expect((await loadPosPriceBook(waiter.id)).outlets.size).toBe(0);

    await run(
      `INSERT INTO restaurant_memberships (restaurant_id, user_id, role, granted_at, granted_by)
       VALUES ($1, $2, 'staff', $3, $4)`,
      [restaurantId, waiter.id, new Date().toISOString(), owner.id]
    );
    expect(await listPosOutlets(waiter.id)).toHaveLength(1);

    await run("UPDATE managed_restaurants SET status = 'suspended' WHERE id = $1", [restaurantId]);
    expect(await listPosOutlets(owner.id)).toEqual([]);
    expect(await listPosOutlets(waiter.id)).toEqual([]);
  });
});
