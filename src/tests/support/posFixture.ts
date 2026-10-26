/**
 * TEST FIXTURE ONLY. Terminal outlets built from the legacy fictional catalog, for engine tests
 * that run without a database. The terminal itself bills only restaurants loaded from Postgres.
 */
import type { PosMenuItem, PosOutlet } from "@/lib/pos/posEngine";
import { RESTAURANTS_DATA } from "./legacyCatalog";

export const TEST_OUTLETS: PosOutlet[] = RESTAURANTS_DATA.map((restaurant) => ({
  outletId: restaurant.resId,
  name: restaurant.name,
  locality: restaurant.locality,
  // 5% GST, so the engine tests keep exercising tax and its rounding.
  taxRateBps: 500,
  seesAllSales: true,
  fssaiNumber: "",
  gstin: "",
  menu: restaurant.menus.flatMap((menu) =>
    menu.categories.flatMap((category) =>
      category.items.map(
        (item): PosMenuItem => ({
          itemId: item.id,
          name: item.name,
          dishId: item.id,
          dishName: item.name,
          portion: null,
          price: Math.round(item.price),
          categoryName: category.name,
          dietary: item.dietary,
          bestseller: Boolean(item.bestseller),
        })
      )
    )
  ),
}));

/** The outlet fields openTableSession and openShift take. */
export function outletInput(outlet: PosOutlet): {
  outletId: number;
  outletName: string;
  taxRateBps: number;
} {
  return { outletId: outlet.outletId, outletName: outlet.name, taxRateBps: outlet.taxRateBps };
}

export const OUTLET = outletInput(TEST_OUTLETS[0]);
export const SECOND_OUTLET = outletInput(TEST_OUTLETS[1]);
export const MENU = TEST_OUTLETS[0].menu;
