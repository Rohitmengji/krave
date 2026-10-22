import { getDb } from "./db";
import { findDishAcrossRestaurants } from "@/lib/cartEngine";
import { RESTAURANTS_DATA } from "@/data/zomatoReconstructedData";

/**
 * The 86 list is outlet-wide, not per device or per account, so a dish sold out at the
 * counter disappears from the storefront for everyone immediately. Reading is open;
 * marking requires a signed-in operator, since one anonymous visitor must not be able to
 * take a dish off a real menu.
 */
export function listUnavailableItems(outletId?: number): string[] {
  const db = getDb();
  const rows = (
    outletId === undefined
      ? db.prepare("SELECT item_id FROM dish_availability").all()
      : db.prepare("SELECT item_id FROM dish_availability WHERE outlet_id = ?").all(outletId)
  ) as Record<string, unknown>[];
  return rows.map((row) => String(row.item_id));
}

export function setDishAvailability(
  userId: string,
  input: unknown
): { unavailableItemIds: string[]; itemId: string; unavailable: boolean } {
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
  const db = getDb();
  if (body.unavailable) {
    db.prepare(
      `INSERT INTO dish_availability (outlet_id, item_id, marked_at, marked_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(outlet_id, item_id) DO UPDATE SET marked_at = excluded.marked_at,
         marked_by = excluded.marked_by`
    ).run(outletId, itemId, new Date().toISOString(), userId);
  } else {
    db.prepare("DELETE FROM dish_availability WHERE outlet_id = ? AND item_id = ?").run(
      outletId,
      itemId
    );
  }

  return {
    unavailableItemIds: listUnavailableItems(),
    itemId,
    unavailable: body.unavailable,
  };
}

/** Drops rows for dishes the catalog no longer has, so a stale 86 cannot hide a live menu. */
export function pruneUnknownAvailability(): number {
  const known = new Set(
    RESTAURANTS_DATA.flatMap((restaurant) =>
      restaurant.menus.flatMap((menu) =>
        menu.categories.flatMap((category) => category.items.map((item) => item.id))
      )
    )
  );
  const db = getDb();
  const rows = db.prepare("SELECT outlet_id, item_id FROM dish_availability").all() as Record<
    string,
    unknown
  >[];

  let removed = 0;
  const remove = db.prepare("DELETE FROM dish_availability WHERE outlet_id = ? AND item_id = ?");
  for (const row of rows) {
    const itemId = String(row.item_id);
    if (!known.has(itemId)) {
      remove.run(Number(row.outlet_id), itemId);
      removed += 1;
    }
  }
  return removed;
}
