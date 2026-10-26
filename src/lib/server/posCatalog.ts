import { rows } from "./pg";
import { isRestaurantAdmin, type RestaurantRole } from "./restaurantStore";
import { unitPricePaise } from "@/lib/managedOrders";
import type { PosMenuItem, PosOutlet } from "@/lib/pos/posEngine";
import type { DietaryType } from "@/types/krave";

/** A dish with portions is rung up per portion, so its terminal id names both. */
const PORTION_SEPARATOR = "~";

type Row = Record<string, unknown>;

interface CatalogDish {
  restaurantId: string;
  item: PosMenuItem;
  /** Only dishes a guest can order right now are offered at the counter. */
  orderable: boolean;
}

export function posItemId(itemId: string, variantId: string | null): string {
  return variantId ? `${itemId}${PORTION_SEPARATOR}${variantId}` : itemId;
}

function posDietary(tags: readonly string[]): DietaryType {
  if (tags.includes("non-vegetarian")) return "non-veg";
  if (tags.includes("contains-egg")) return "egg";
  if (tags.includes("vegetarian") || tags.includes("vegan")) return "veg";
  // Undeclared shows as non-veg, so the counter never tells a guest an unknown dish is vegetarian.
  return "non-veg";
}

function textList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * Every dish of these restaurants, priced the way online orders are (discounted price, plus
 * the portion's difference). Prices that are not whole rupees are left out: the terminal bills
 * in whole rupees and must not round a price the owner set.
 */
async function loadDishes(restaurantIds: string[]): Promise<CatalogDish[]> {
  if (restaurantIds.length === 0) return [];
  const [items, variants] = await Promise.all([
    rows<Row>(
      `SELECT i.id, i.restaurant_id, i.name, i.price_paise, i.discounted_price_paise,
         i.dietary_tags, i.featured, i.published, i.available, c.visible, c.name AS category_name
       FROM menu_items i
       JOIN menu_categories c ON c.id = i.category_id AND c.restaurant_id = i.restaurant_id
       WHERE i.restaurant_id = ANY($1::text[])
       ORDER BY c.display_order, c.name, i.display_order, i.name`,
      [restaurantIds]
    ),
    rows<Row>(
      `SELECT id, item_id, name, price_delta_paise, available FROM menu_item_variants
       WHERE restaurant_id = ANY($1::text[]) ORDER BY display_order, name`,
      [restaurantIds]
    ),
  ]);

  const variantsByItem = new Map<string, Row[]>();
  for (const variant of variants) {
    const key = String(variant.item_id);
    variantsByItem.set(key, [...(variantsByItem.get(key) ?? []), variant]);
  }

  return items.flatMap((row): CatalogDish[] => {
    const id = String(row.id);
    const portions = variantsByItem.get(id) ?? [];
    const priced = {
      pricePaise: Number(row.price_paise),
      discountedPricePaise: row.discounted_price_paise == null ? null : Number(row.discounted_price_paise),
      variants: portions.map((variant) => ({
        id: String(variant.id),
        priceDeltaPaise: Number(variant.price_delta_paise),
      })),
      addons: [],
    };
    const dishOrderable =
      Number(row.published) === 1 && Number(row.available) === 1 && Number(row.visible) === 1;
    const choices: { variantId: string | null; label: string | null; orderable: boolean }[] =
      portions.length === 0
        ? [{ variantId: null, label: null, orderable: dishOrderable }]
        : portions.map((variant) => ({
            variantId: String(variant.id),
            label: String(variant.name),
            orderable: dishOrderable && Number(variant.available) === 1,
          }));
    return choices.flatMap((choice): CatalogDish[] => {
      const paise = unitPricePaise(priced, choice.variantId, []);
      if (paise === null || paise % 100 !== 0) return [];
      return [
        {
          restaurantId: String(row.restaurant_id),
          orderable: choice.orderable,
          item: {
            itemId: posItemId(id, choice.variantId),
            name: choice.label ? `${String(row.name)} (${choice.label})` : String(row.name),
            dishId: id,
            dishName: String(row.name),
            portion: choice.label,
            price: paise / 100,
            categoryName: String(row.category_name),
            dietary: posDietary(textList(row.dietary_tags)),
            bestseller: Number(row.featured) === 1,
          },
        },
      ];
    });
  });
}

/**
 * The restaurants (`r`) an account may bill for: `$1` is the account, `$2` whether it is a
 * platform admin. A suspended restaurant cannot bill; drafts can, so dine-in can start before
 * going online.
 */
export const BILLABLE_RESTAURANT_SQL = `r.status <> 'suspended'
  AND ($2::boolean OR EXISTS (
    SELECT 1 FROM restaurant_memberships m WHERE m.restaurant_id = r.id AND m.user_id = $1))`;

const ROLES: readonly RestaurantRole[] = ["owner", "admin", "manager", "staff"];

/** Owners and managers run the money side: every bill of the restaurant, and its totals. */
export function seesAllSales(role: RestaurantRole): boolean {
  return role !== "staff";
}

async function billableRestaurants(
  userId: string
): Promise<
  {
    id: string;
    outletId: number;
    name: string;
    city: string;
    taxRateBps: number;
    role: RestaurantRole;
    fssaiNumber: string;
    gstin: string;
  }[]
> {
  const admin = await isRestaurantAdmin(userId);
  const found = await rows<Row>(
    `SELECT r.id, r.pos_outlet_id, r.name, r.city, r.tax_enabled, r.tax_rate_bps, r.fssai_number, r.gstin,
            (SELECT m.role FROM restaurant_memberships m
             WHERE m.restaurant_id = r.id AND m.user_id = $1) AS role
     FROM managed_restaurants r
     WHERE ${BILLABLE_RESTAURANT_SQL}
     ORDER BY r.name, r.id`,
    [userId, admin]
  );
  return found.map((row) => ({
    id: String(row.id),
    outletId: Number(row.pos_outlet_id),
    name: String(row.name),
    city: String(row.city),
    // The same setting online orders use, so a table and an online order cost the same.
    taxRateBps: Number(row.tax_enabled) === 1 ? Number(row.tax_rate_bps) : 0,
    role: ROLES.find((known) => known === row.role) ?? (admin ? "admin" : "staff"),
    fssaiNumber: String(row.fssai_number ?? ""),
    gstin: String(row.gstin ?? ""),
  }));
}

/** The restaurant's name when this account may bill (and so see the bills of) an outlet. */
export async function billableOutletName(userId: string, outletId: number): Promise<string | null> {
  const restaurant = (await billableRestaurants(userId)).find(
    (candidate) => candidate.outletId === outletId
  );
  return restaurant?.name ?? null;
}

/** The restaurant's name and this account's role there, or null when it cannot bill for it. */
export async function billableOutletAccess(
  userId: string,
  outletId: number
): Promise<{ name: string; role: RestaurantRole } | null> {
  const restaurant = (await billableRestaurants(userId)).find(
    (candidate) => candidate.outletId === outletId
  );
  return restaurant ? { name: restaurant.name, role: restaurant.role } : null;
}

/** Outlets this account may bill for, and whether it may see all of their sales. */
export async function billableOutletScopes(
  userId: string
): Promise<{ outletIds: number[]; salesOutletIds: number[] }> {
  const restaurants = await billableRestaurants(userId);
  return {
    outletIds: restaurants.map((restaurant) => restaurant.outletId),
    salesOutletIds: restaurants
      .filter((restaurant) => seesAllSales(restaurant.role))
      .map((restaurant) => restaurant.outletId),
  };
}

/** The restaurants this account may bill for at a table, each with its orderable dishes. */
export async function listPosOutlets(userId: string): Promise<PosOutlet[]> {
  const restaurants = await billableRestaurants(userId);
  const dishes = await loadDishes(restaurants.map((restaurant) => restaurant.id));
  return restaurants.map((restaurant) => ({
    outletId: restaurant.outletId,
    name: restaurant.name,
    locality: restaurant.city,
    taxRateBps: restaurant.taxRateBps,
    seesAllSales: seesAllSales(restaurant.role),
    fssaiNumber: restaurant.fssaiNumber,
    gstin: restaurant.gstin,
    menu: dishes
      .filter((dish) => dish.orderable && dish.restaurantId === restaurant.id)
      .map((dish) => dish.item),
  }));
}

export interface PosPriceBook {
  /** Outlets this account may write bills for, with the restaurant's own name. */
  outlets: Map<number, string>;
  /** Current whole-rupee price per outlet and terminal item id, orderable or not. */
  priceOf(outletId: number, itemId: string): number | null;
  /** The restaurant's tax rate now, for tables the server has not seen before. */
  taxRateOf(outletId: number): number;
}

/**
 * What a sync checks bills against, read before its transaction opens. Dishes taken off the
 * menu still have a price here, so a table that ordered one before it was hidden can settle.
 */
export async function loadPosPriceBook(userId: string): Promise<PosPriceBook> {
  const restaurants = await billableRestaurants(userId);
  const outletOf = new Map(restaurants.map((restaurant) => [restaurant.id, restaurant.outletId]));
  const prices = new Map<string, number>();
  for (const dish of await loadDishes([...outletOf.keys()])) {
    prices.set(`${outletOf.get(dish.restaurantId)}:${dish.item.itemId}`, dish.item.price);
  }
  const taxRates = new Map(restaurants.map((restaurant) => [restaurant.outletId, restaurant.taxRateBps]));
  return {
    outlets: new Map(restaurants.map((restaurant) => [restaurant.outletId, restaurant.name])),
    priceOf: (outletId, itemId) => prices.get(`${outletId}:${itemId}`) ?? null,
    taxRateOf: (outletId) => taxRates.get(outletId) ?? 0,
  };
}
