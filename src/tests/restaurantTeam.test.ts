import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deleteAccount, registerUser } from "@/lib/server/auth";
import { rows, run, transaction } from "@/lib/server/pg";
import { listPosOutlets } from "@/lib/server/posCatalog";
import { syncPosState } from "@/lib/server/posStore";
import {
  addItemToSession,
  calculatePosBill,
  openTableSession,
  sendPendingToKitchen,
  settleSession,
} from "@/lib/pos/posEngine";
import { assertCanManageRestaurant, listManagedRestaurants } from "@/lib/server/restaurantStore";
import {
  grantTeamAccess,
  listTeam,
  revokeTeamAccess,
  TEAM_LAST_OWNER,
  TEAM_NO_ACCOUNT,
  TEAM_NOT_YOURSELF,
  TEAM_OWNER_ONLY,
} from "@/lib/server/restaurantTeam";
import { seedJagadamba } from "../../scripts/seed-jagadamba.mjs";
import {
  hasTestDatabase,
  resetTestDatabase,
  startTestDatabase,
  stopTestDatabase,
} from "./support/testDb";

const PIN = "135790";

describe.skipIf(!hasTestDatabase)("restaurant team access", () => {
  beforeAll(startTestDatabase);
  afterAll(stopTestDatabase);
  beforeEach(resetTestDatabase);

  async function restaurantWithOwner() {
    const owner = await registerUser({ email: "owner@jagadamba.test", password: PIN });
    const { restaurantId } = await transaction((client) =>
      seedJagadamba(client, { ownerEmail: "owner@jagadamba.test" })
    );
    return { owner, restaurantId: String(restaurantId) };
  }

  const account = (email: string) => registerUser({ email, password: PIN });
  const roles = async (actorId: string, restaurantId: string) =>
    (await listTeam(actorId, restaurantId)).members.map((member) => `${member.email}:${member.role}`);
  const auditActions = async (restaurantId: string) =>
    (
      await rows<{ action: string }>(
        "SELECT action FROM restaurant_audit WHERE restaurant_id = $1 AND action LIKE 'TEAM_%' ORDER BY id",
        [restaurantId]
      )
    ).map((row) => row.action);

  it("lets the owner add a waiter by email, who can then bill but not run the restaurant", async () => {
    const { owner, restaurantId } = await restaurantWithOwner();
    const waiter = await account("hemant@krave.test");
    expect(await listPosOutlets(waiter.id)).toEqual([]);

    const team = await grantTeamAccess(owner.id, restaurantId, { email: "  Hemant@KRAVE.test ", role: "staff" });
    expect(team.canManage).toBe(true);
    expect(team.members.map((member) => [member.email, member.role, member.you])).toEqual([
      ["owner@jagadamba.test", "owner", true],
      ["hemant@krave.test", "staff", false],
    ]);

    expect(await listPosOutlets(waiter.id)).toHaveLength(1);
    await expect(assertCanManageRestaurant(waiter.id, restaurantId)).rejects.toThrow(/do not have access/);
    // The workspace lists only restaurants the account runs; a waiter's place is the POS.
    expect(await listManagedRestaurants(waiter.id)).toEqual([]);
    expect(await auditActions(restaurantId)).toEqual(["TEAM_MEMBER_ADDED"]);
  });

  it("refuses an email with no account and a role it does not offer, changing nothing", async () => {
    const { owner, restaurantId } = await restaurantWithOwner();
    await account("laxman@krave.test");

    await expect(
      grantTeamAccess(owner.id, restaurantId, { email: "nobody@krave.test", role: "staff" })
    ).rejects.toThrow(TEAM_NO_ACCOUNT);
    for (const role of ["admin", "boss", "", null, 1]) {
      await expect(
        grantTeamAccess(owner.id, restaurantId, { email: "laxman@krave.test", role })
      ).rejects.toThrow("Choose Owner, Manager or Waiter.");
    }
    await expect(grantTeamAccess(owner.id, restaurantId, { email: "laxman", role: "staff" })).rejects.toThrow(
      "Enter a valid email address."
    );
    expect(await roles(owner.id, restaurantId)).toEqual(["owner@jagadamba.test:owner"]);
    expect(await auditActions(restaurantId)).toEqual([]);
  });

  it("changes a role in place, and a repeated grant changes nothing", async () => {
    const { owner, restaurantId } = await restaurantWithOwner();
    const manager = await account("manager@krave.test");

    await grantTeamAccess(owner.id, restaurantId, { email: manager.email, role: "staff" });
    // A retry after a timeout that had in fact succeeded.
    await grantTeamAccess(owner.id, restaurantId, { email: manager.email, role: "staff" });
    expect(await listManagedRestaurants(manager.id)).toEqual([]);

    await grantTeamAccess(owner.id, restaurantId, { email: manager.email, role: "manager" });
    expect(await roles(owner.id, restaurantId)).toEqual([
      "owner@jagadamba.test:owner",
      "manager@krave.test:manager",
    ]);
    expect((await listManagedRestaurants(manager.id)).map((restaurant) => restaurant.id)).toEqual([restaurantId]);
    expect(await auditActions(restaurantId)).toEqual(["TEAM_MEMBER_ADDED", "TEAM_ROLE_CHANGED"]);
  });

  it("lets managers see the team but only owners change it, and strangers neither", async () => {
    const { owner, restaurantId } = await restaurantWithOwner();
    const manager = await account("manager@krave.test");
    const waiter = await account("waiter@krave.test");
    const stranger = await account("stranger@krave.test");
    await grantTeamAccess(owner.id, restaurantId, { email: manager.email, role: "manager" });
    await grantTeamAccess(owner.id, restaurantId, { email: waiter.email, role: "staff" });

    const seen = await listTeam(manager.id, restaurantId);
    expect(seen.canManage).toBe(false);
    expect(seen.members).toHaveLength(3);
    await expect(
      grantTeamAccess(manager.id, restaurantId, { email: stranger.email, role: "owner" })
    ).rejects.toThrow(TEAM_OWNER_ONLY);
    await expect(revokeTeamAccess(manager.id, restaurantId, { userId: waiter.id })).rejects.toThrow(
      TEAM_OWNER_ONLY
    );

    // A waiter is on the team but neither sees nor changes it; a stranger is told nothing.
    await expect(listTeam(waiter.id, restaurantId)).rejects.toThrow(/do not have access/);
    await expect(
      grantTeamAccess(waiter.id, restaurantId, { email: stranger.email, role: "owner" })
    ).rejects.toThrow(TEAM_OWNER_ONLY);
    await expect(listTeam(stranger.id, restaurantId)).rejects.toThrow(/do not have access/);
    await expect(
      grantTeamAccess(stranger.id, restaurantId, { email: stranger.email, role: "owner" })
    ).rejects.toThrow(/do not have access/);
    await expect(revokeTeamAccess(stranger.id, restaurantId, { userId: owner.id })).rejects.toThrow(
      /do not have access/
    );
    await expect(listTeam(owner.id, "rst_someone_else")).rejects.toThrow(/do not have access/);
    expect(await roles(owner.id, restaurantId)).toHaveLength(3);
  });

  it("never lets anyone change their own access or leave the restaurant without an owner", async () => {
    const { owner, restaurantId } = await restaurantWithOwner();
    const partner = await account("partner@krave.test");

    await expect(
      grantTeamAccess(owner.id, restaurantId, { email: owner.email, role: "staff" })
    ).rejects.toThrow(TEAM_NOT_YOURSELF);
    await expect(revokeTeamAccess(owner.id, restaurantId, { userId: owner.id })).rejects.toThrow(
      TEAM_NOT_YOURSELF
    );

    // An admin (a role only set up directly) can change the team but not remove the last owner.
    await run(
      `INSERT INTO restaurant_memberships (restaurant_id, user_id, role, granted_at, granted_by)
       VALUES ($1, $2, 'admin', $3, $4)`,
      [restaurantId, partner.id, new Date().toISOString(), owner.id]
    );
    await expect(
      grantTeamAccess(partner.id, restaurantId, { email: owner.email, role: "manager" })
    ).rejects.toThrow(TEAM_LAST_OWNER);
    await expect(revokeTeamAccess(partner.id, restaurantId, { userId: owner.id })).rejects.toThrow(
      TEAM_LAST_OWNER
    );
    expect(await roles(owner.id, restaurantId)).toEqual([
      "owner@jagadamba.test:owner",
      "partner@krave.test:admin",
    ]);
  });

  it("leaves one owner when two owners remove each other at the same moment", async () => {
    const { owner, restaurantId } = await restaurantWithOwner();
    const partner = await account("partner@krave.test");
    await grantTeamAccess(owner.id, restaurantId, { email: partner.email, role: "owner" });
    // Open every pooled connection first. Otherwise one removal waits for a fresh connection
    // and finishes before the other starts, and the two never overlap.
    await Promise.all(Array.from({ length: 4 }, () => rows("SELECT pg_sleep(0.2)")));

    const results = await Promise.allSettled([
      revokeTeamAccess(owner.id, restaurantId, { userId: partner.id }),
      revokeTeamAccess(partner.id, restaurantId, { userId: owner.id }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const left = await rows<{ role: string }>(
      "SELECT role FROM restaurant_memberships WHERE restaurant_id = $1",
      [restaurantId]
    );
    expect(left).toEqual([{ role: "owner" }]);
  });

  it("takes the POS away on removal, and removing again changes nothing", async () => {
    const { owner, restaurantId } = await restaurantWithOwner();
    const waiter = await account("waiter@krave.test");
    await grantTeamAccess(owner.id, restaurantId, { email: waiter.email, role: "staff" });
    expect(await listPosOutlets(waiter.id)).toHaveLength(1);

    const team = await revokeTeamAccess(owner.id, restaurantId, { userId: waiter.id });
    expect(team.members.map((member) => member.email)).toEqual(["owner@jagadamba.test"]);
    expect(await listPosOutlets(waiter.id)).toEqual([]);

    await revokeTeamAccess(owner.id, restaurantId, { userId: waiter.id });
    await expect(revokeTeamAccess(owner.id, restaurantId, { userId: "" })).rejects.toThrow("Choose who to remove.");
    expect(await auditActions(restaurantId)).toEqual(["TEAM_MEMBER_ADDED", "TEAM_MEMBER_REMOVED"]);
  });

  it("keeps the restaurant's bills when a waiter who opened them deletes their account", async () => {
    const { owner, restaurantId } = await restaurantWithOwner();
    const waiter = await account("waiter@krave.test");
    await grantTeamAccess(owner.id, restaurantId, { email: waiter.email, role: "staff" });
    const [outlet] = await listPosOutlets(waiter.id);
    let table = openTableSession({
      outletId: outlet.outletId,
      outletName: outlet.name,
      taxRateBps: outlet.taxRateBps,
      tableId: "T1",
      guestCount: 2,
      serverName: "Hemant",
    });
    table = sendPendingToKitchen(addItemToSession(table, outlet.menu[0], 1)).session;
    const paid = settleSession(table, "CASH", calculatePosBill(table).grandTotal);
    expect((await syncPosState(waiter.id, { sessions: [paid], shift: null })).rejected).toEqual([]);

    await revokeTeamAccess(owner.id, restaurantId, { userId: waiter.id });
    await deleteAccount(waiter.id, { password: PIN, confirmation: "DELETE" });
    const bills = await rows<{ user_id: string; grand_total: number }>(
      "SELECT user_id, grand_total FROM pos_sessions WHERE outlet_id = $1",
      [outlet.outletId]
    );
    expect(bills).toEqual([{ user_id: owner.id, grand_total: calculatePosBill(paid).grandTotal }]);
  });
});
