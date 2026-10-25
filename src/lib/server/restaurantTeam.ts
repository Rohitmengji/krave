import { normalizeEmail } from "./auth";
import { transaction, type Queryable } from "./pg";
import { isRestaurantAdmin, type RestaurantRole } from "./restaurantStore";

/** Roles an owner can give from the workspace. `admin` exists in the schema but is not offered. */
export const TEAM_ROLES = ["owner", "manager", "staff"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

export interface TeamMember {
  userId: string;
  email: string;
  displayName: string;
  role: RestaurantRole;
  /** The signed-in account. Nobody changes their own access, so nobody locks themselves out. */
  you: boolean;
}

export interface RestaurantTeam {
  members: TeamMember[];
  /** Owners and platform admins change the team; managers can only see it. */
  canManage: boolean;
}

export const TEAM_OWNER_ONLY = "Only an owner can change who has access to this restaurant.";
export const TEAM_NO_ACCOUNT =
  "No KRAVE account uses that email yet. Ask them to sign up with it first, then add them here.";
export const TEAM_LAST_OWNER =
  "The restaurant must keep at least one owner. Make someone else an owner first.";
export const TEAM_NOT_YOURSELF = "You can't change your own access. Ask another owner to do it.";
const NO_ACCESS = "You do not have access to this restaurant.";

const ROLES: readonly RestaurantRole[] = ["owner", "admin", "manager", "staff"];

function isTeamRole(value: unknown): value is TeamRole {
  return TEAM_ROLES.some((role) => role === value);
}

async function roleOf(db: Queryable, restaurantId: string, userId: string): Promise<RestaurantRole | null> {
  const found = await db.query<{ role: string }>(
    "SELECT role FROM restaurant_memberships WHERE restaurant_id = $1 AND user_id = $2",
    [restaurantId, userId]
  );
  const role = found.rows[0]?.role;
  return ROLES.find((known) => known === role) ?? null;
}

async function readTeam(
  db: Queryable,
  restaurantId: string,
  actorId: string,
  canManage: boolean
): Promise<RestaurantTeam> {
  const found = await db.query<{ user_id: string; email: string; display_name: string; role: string }>(
    `SELECT m.user_id, u.email, u.display_name, m.role
     FROM restaurant_memberships m
     JOIN users u ON u.id = m.user_id
     WHERE m.restaurant_id = $1
     ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'manager' THEN 2 ELSE 3 END,
       lower(u.display_name), u.email`,
    [restaurantId]
  );
  return {
    canManage,
    members: found.rows.map((row) => ({
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: ROLES.find((known) => known === row.role) ?? "staff",
      you: row.user_id === actorId,
    })),
  };
}

/**
 * Locks the restaurant for the rest of the transaction, then checks the actor may change its
 * team. The lock makes concurrent changes apply one after another, so two owners removing
 * each other cannot both see a second owner and leave the restaurant with none. The actor's
 * own role is read under the same lock, so a just-removed owner cannot make one last change.
 */
async function lockForTeamChange(
  client: Queryable,
  actorId: string,
  restaurantId: string,
  platformAdmin: boolean
): Promise<void> {
  const locked = await client.query(
    "SELECT 1 FROM managed_restaurants WHERE id = $1 FOR NO KEY UPDATE",
    [restaurantId]
  );
  if (locked.rowCount === 0) throw new Error(platformAdmin ? "Restaurant not found." : NO_ACCESS);
  if (platformAdmin) return;
  const role = await roleOf(client, restaurantId, actorId);
  if (role === "owner" || role === "admin") return;
  throw new Error(role ? TEAM_OWNER_ONLY : NO_ACCESS);
}

async function assertAnotherOwner(client: Queryable, restaurantId: string): Promise<void> {
  const owners = await client.query<{ count: string }>(
    "SELECT COUNT(*) AS count FROM restaurant_memberships WHERE restaurant_id = $1 AND role = 'owner'",
    [restaurantId]
  );
  if (Number(owners.rows[0]?.count ?? 0) < 2) throw new Error(TEAM_LAST_OWNER);
}

async function audit(
  client: Queryable,
  restaurantId: string,
  actorId: string,
  action: string,
  subjectId: string,
  detail: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, detail, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [restaurantId, actorId, action, subjectId, JSON.stringify(detail), new Date().toISOString()]
  );
}

/** Everyone with access to the restaurant. Managers may look; only owners change it. */
export async function listTeam(actorId: string, restaurantId: string): Promise<RestaurantTeam> {
  const platformAdmin = await isRestaurantAdmin(actorId);
  return transaction(async (client) => {
    if (platformAdmin) {
      const found = await client.query("SELECT 1 FROM managed_restaurants WHERE id = $1", [restaurantId]);
      if (found.rowCount === 0) throw new Error("Restaurant not found.");
      return readTeam(client, restaurantId, actorId, true);
    }
    const role = await roleOf(client, restaurantId, actorId);
    if (role !== "owner" && role !== "admin" && role !== "manager") throw new Error(NO_ACCESS);
    return readTeam(client, restaurantId, actorId, role !== "manager");
  });
}

/**
 * Gives an existing account access, or changes the role it already has. The person signs up
 * first, so the owner sees their name next to the email before anything is granted. Giving
 * the role someone already has changes nothing, so a retried request is harmless.
 */
export async function grantTeamAccess(
  actorId: string,
  restaurantId: string,
  input: unknown
): Promise<RestaurantTeam> {
  const body = (input ?? {}) as Record<string, unknown>;
  const email = normalizeEmail(body.email);
  const role = body.role;
  if (!isTeamRole(role)) throw new Error("Choose Owner, Manager or Waiter.");
  const platformAdmin = await isRestaurantAdmin(actorId);

  return transaction(async (client) => {
    await lockForTeamChange(client, actorId, restaurantId, platformAdmin);
    const target = (
      await client.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email])
    ).rows[0];
    if (!target) throw new Error(TEAM_NO_ACCOUNT);
    if (target.id === actorId) throw new Error(TEAM_NOT_YOURSELF);

    const previous = await roleOf(client, restaurantId, target.id);
    if (previous !== role) {
      if (previous === "owner") await assertAnotherOwner(client, restaurantId);
      await client.query(
        `INSERT INTO restaurant_memberships (restaurant_id, user_id, role, granted_at, granted_by)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (restaurant_id, user_id)
         DO UPDATE SET role = EXCLUDED.role, granted_at = EXCLUDED.granted_at, granted_by = EXCLUDED.granted_by`,
        [restaurantId, target.id, role, new Date().toISOString(), actorId]
      );
      await audit(
        client,
        restaurantId,
        actorId,
        previous ? "TEAM_ROLE_CHANGED" : "TEAM_MEMBER_ADDED",
        target.id,
        { email, role, previousRole: previous }
      );
    }
    return readTeam(client, restaurantId, actorId, true);
  });
}

/** Takes away someone's access. Removing a person who has none already changes nothing. */
export async function revokeTeamAccess(
  actorId: string,
  restaurantId: string,
  input: unknown
): Promise<RestaurantTeam> {
  const body = (input ?? {}) as Record<string, unknown>;
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!userId || userId.length > 80) throw new Error("Choose who to remove.");
  const platformAdmin = await isRestaurantAdmin(actorId);

  return transaction(async (client) => {
    await lockForTeamChange(client, actorId, restaurantId, platformAdmin);
    if (userId === actorId) throw new Error(TEAM_NOT_YOURSELF);

    const previous = await roleOf(client, restaurantId, userId);
    if (previous) {
      if (previous === "owner") await assertAnotherOwner(client, restaurantId);
      await client.query(
        "DELETE FROM restaurant_memberships WHERE restaurant_id = $1 AND user_id = $2",
        [restaurantId, userId]
      );
      await audit(client, restaurantId, actorId, "TEAM_MEMBER_REMOVED", userId, { previousRole: previous });
    }
    return readTeam(client, restaurantId, actorId, true);
  });
}
