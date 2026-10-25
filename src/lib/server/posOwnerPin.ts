import {
  checkThrottledSecret,
  hashSecret,
  LOGIN_WINDOW_MINUTES,
  verifyAccountPassword,
} from "./auth";
import { one, run } from "./pg";
import { billableOutletName } from "./posCatalog";
import { assertCanManageRestaurant } from "./restaurantStore";

const PIN_PATTERN = /^\d{4,6}$/;

export const POS_PIN_MISSING = "Set an owner PIN first: Owner menu → Table POS owner PIN.";
export const POS_PIN_WRONG = "Wrong owner PIN.";

export async function hasPosOwnerPin(userId: string, restaurantId: string): Promise<boolean> {
  await assertCanManageRestaurant(userId, restaurantId);
  const row = await one<{ pos_pin_hash: string | null }>(
    "SELECT pos_pin_hash FROM managed_restaurants WHERE id = $1",
    [restaurantId]
  );
  return Boolean(row?.pos_pin_hash);
}

/**
 * The counter phone is usually signed in as the owner and passed around, so being signed in
 * proves nothing about who is holding it; the account password does. It also resets a
 * forgotten PIN.
 */
export async function setPosOwnerPin(
  userId: string,
  restaurantId: string,
  input: unknown,
  clientKey: string
): Promise<void> {
  await assertCanManageRestaurant(userId, restaurantId);
  const body = (input ?? {}) as Record<string, unknown>;
  const pin = typeof body.pin === "string" ? body.pin.trim() : "";
  if (!PIN_PATTERN.test(pin)) {
    throw new Error("Choose a PIN of 4 to 6 digits.");
  }
  await verifyAccountPassword(userId, body.password, clientKey);
  await run("UPDATE managed_restaurants SET pos_pin_hash = $1, updated_at = $2 WHERE id = $3", [
    await hashSecret(pin),
    new Date().toISOString(),
    restaurantId,
  ]);
}

/**
 * The owner's approval at the counter for changing a paid bill. The change itself is made by
 * the terminal; this only answers whether the person holding it knows the owner's PIN. The
 * owner types it on whichever phone holds the bill, so any account that bills the outlet may
 * ask, a waiter's included.
 */
export async function confirmPosOwnerPin(userId: string, input: unknown): Promise<void> {
  const body = (input ?? {}) as Record<string, unknown>;
  const outletId = Number(body.outletId);
  const restaurant =
    Number.isSafeInteger(outletId) && (await billableOutletName(userId, outletId)) !== null
      ? await one<{ id: string; pos_pin_hash: string | null }>(
          "SELECT id, pos_pin_hash FROM managed_restaurants WHERE pos_outlet_id = $1",
          [outletId]
        )
      : null;
  if (!restaurant) throw new Error("You do not have access to this restaurant.");
  if (!restaurant.pos_pin_hash) throw new Error(POS_PIN_MISSING);

  const pin = typeof body.pin === "string" ? body.pin.trim() : "";
  const matches = await checkThrottledSecret(
    `pos-pin:${restaurant.id}`,
    pin,
    restaurant.pos_pin_hash,
    `Too many wrong PINs. Try again in ${LOGIN_WINDOW_MINUTES} minutes.`
  );
  if (!matches) throw new Error(POS_PIN_WRONG);
}
