import type { PosOutlet } from "@/lib/pos/posEngine";
import { transaction } from "@/lib/server/pg";
import { listPosOutlets } from "@/lib/server/posCatalog";
import { readSeedMenu, seedJagadamba } from "../../../scripts/seed-jagadamba.mjs";

const FULL_MENU = readSeedMenu();
// Two dishes are enough here, and each seeded row is a round trip to the test branch.
const SHORT_MENU = {
  ...FULL_MENU,
  categories: [{ ...FULL_MENU.categories[0], items: FULL_MENU.categories[0].items.slice(0, 2) }],
};

/**
 * Gives this account a real restaurant in the test database (Jagadamba, with the first two
 * dishes of its seed menu) and returns it as the terminal loads it. The menu is Mutton
 * Biriyani (Half) ₹120, (Full) ₹200, then Chicken Biriyani (Half) ₹60 and (Full) ₹100.
 */
export async function seedPosOutlet(owner: { id: string; email: string }): Promise<PosOutlet> {
  await transaction((client) => seedJagadamba(client, { ownerEmail: owner.email, menu: SHORT_MENU }));
  const [outlet] = await listPosOutlets(owner.id);
  return outlet;
}
