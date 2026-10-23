import { one, rows, run } from "./pg";

/**
 * Who may act on an outlet: see its tickets, change what it is serving, sync its
 * terminal, settle claims against it.
 *
 * Until this existed, any signed-in account could do all of that for any outlet.
 */

/**
 * Demo convenience: treats every signed-in account as staff everywhere.
 *
 * Off unless explicitly set, so a real deployment is closed by default and has to
 * opt in to being open rather than opt out of being wide open.
 */
function openStaffMode(): boolean {
  return process.env.KRAVE_OPEN_STAFF === "1";
}

/** Platform operators, listed by email, who are staff at every outlet. */
function configuredStaffEmails(): Set<string> {
  const raw = process.env.KRAVE_STAFF_EMAILS ?? "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
  );
}

async function emailFor(userId: string): Promise<string> {
  const row = await one<Record<string, unknown>>("SELECT email FROM users WHERE id = $1", [
    userId,
  ]);
  return row ? String(row.email).toLowerCase() : "";
}

export async function isOutletStaff(userId: string, outletId: number): Promise<boolean> {
  if (openStaffMode()) return true;
  if (!Number.isSafeInteger(outletId)) return false;
  if (configuredStaffEmails().has(await emailFor(userId))) return true;

  const row = await one("SELECT 1 FROM outlet_staff WHERE user_id = $1 AND outlet_id = $2", [
    userId,
    outletId,
  ]);
  return row !== undefined;
}

/** True when this account is staff somewhere, for views that are not outlet-scoped. */
export async function isAnyOutletStaff(userId: string): Promise<boolean> {
  if (openStaffMode()) return true;
  if (configuredStaffEmails().has(await emailFor(userId))) return true;

  const row = await one("SELECT 1 FROM outlet_staff WHERE user_id = $1", [userId]);
  return row !== undefined;
}

export async function assertOutletStaff(userId: string, outletId: number): Promise<void> {
  if (!(await isOutletStaff(userId, outletId))) {
    // Deliberately the same wording whether the outlet is unknown or merely not
    // theirs, so this cannot be used to discover which outlets exist.
    throw new Error("You do not have access to this outlet.");
  }
}

export async function assertAnyOutletStaff(userId: string): Promise<void> {
  if (!(await isAnyOutletStaff(userId))) {
    throw new Error("You do not have access to this outlet.");
  }
}

export async function grantOutletStaff(
  grantedBy: string,
  userId: string,
  outletId: number
): Promise<void> {
  if (!Number.isSafeInteger(outletId)) throw new Error("Unknown outlet.");
  await run(
    `INSERT INTO outlet_staff (user_id, outlet_id, granted_at, granted_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, outlet_id) DO NOTHING`,
    [userId, outletId, new Date().toISOString(), grantedBy]
  );
}

export async function revokeOutletStaff(userId: string, outletId: number): Promise<void> {
  await run("DELETE FROM outlet_staff WHERE user_id = $1 AND outlet_id = $2", [userId, outletId]);
}

export async function listStaffOutlets(userId: string): Promise<number[]> {
  const found = await rows<Record<string, unknown>>(
    "SELECT outlet_id FROM outlet_staff WHERE user_id = $1 ORDER BY outlet_id",
    [userId]
  );
  return found.map((row) => Number(row.outlet_id));
}
