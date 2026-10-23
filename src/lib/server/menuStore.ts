import { rows, run } from "./pg";
import { assertOutletStaff } from "./staff";
import { findDishAcrossRestaurants } from "@/lib/cartEngine";
import { RESTAURANTS_DATA } from "@/data/zomatoReconstructedData";

/**
 * The 86 list is outlet-wide, not per device or per account, so a dish sold out at the
 * counter disappears from the storefront for everyone immediately. Reading is open;
 * marking requires a signed-in operator, since one anonymous visitor must not be able to
 * take a dish off a real menu.
 */
export async function listUnavailableItems(outletId?: number): Promise<string[]> {
  const found = await (outletId === undefined
    ? rows<Record<string, unknown>>("SELECT item_id FROM dish_availability")
    : rows<Record<string, unknown>>(
        "SELECT item_id FROM dish_availability WHERE outlet_id = $1",
        [outletId]
      ));
  return found.map((row) => String(row.item_id));
}

export async function setDishAvailability(
  userId: string,
  input: unknown
): Promise<{ unavailableItemIds: string[]; itemId: string; unavailable: boolean }> {
  const body = (input ?? {}) as Record<string, unknown>;
  const itemId = typeof body.itemId === "string" ? body.itemId : "";
  const found = findDishAcrossRestaurants(itemId);
  if (!found) {
    throw new Error("That dish is not on any menu.");
  }
  if (typeof body.unavailable !== "boolean") {
    throw new Error("Availability must be true or false.");
  }

  // The owning outlet comes from the catalog, never from the caller.
  const outletId = found.restaurant.resId;
  await assertOutletStaff(userId, outletId);

  if (body.unavailable) {
    await run(
      `INSERT INTO dish_availability (outlet_id, item_id, marked_at, marked_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (outlet_id, item_id) DO UPDATE SET marked_at = excluded.marked_at,
         marked_by = excluded.marked_by`,
      [outletId, itemId, new Date().toISOString(), userId]
    );
  } else {
    await run("DELETE FROM dish_availability WHERE outlet_id = $1 AND item_id = $2", [
      outletId,
      itemId,
    ]);
  }

  return {
    unavailableItemIds: await listUnavailableItems(),
    itemId,
    unavailable: body.unavailable,
  };
}

/** Drops rows for dishes the catalog no longer has, so a stale 86 cannot hide a live menu. */
export async function pruneUnknownAvailability(): Promise<number> {
  const known = new Set(
    RESTAURANTS_DATA.flatMap((restaurant) =>
      restaurant.menus.flatMap((menu) =>
        menu.categories.flatMap((category) => category.items.map((item) => item.id))
      )
    )
  );
  const present = await rows<Record<string, unknown>>(
    "SELECT outlet_id, item_id FROM dish_availability"
  );

  const stale = present.filter((row) => !known.has(String(row.item_id)));
  if (stale.length === 0) return 0;

  // One statement rather than a loop: every row is a network round trip here.
  await run(
    `DELETE FROM dish_availability
     WHERE (outlet_id, item_id) IN (
       SELECT * FROM UNNEST($1::int[], $2::text[])
     )`,
    [stale.map((row) => Number(row.outlet_id)), stale.map((row) => String(row.item_id))]
  );
  return stale.length;
}
