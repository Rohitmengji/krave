import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { closePool, one, rows, run, transaction } from "@/lib/server/pg";

/**
 * Exercises the Postgres layer against a real server before the stores are moved onto it.
 *
 * Every behaviour the SQLite stores depend on is checked here, so a dialect gap surfaces
 * now rather than after fifty-odd functions have been rewritten on top of it.
 *
 * Needs DATABASE_URL, so it is skipped in the normal unit run:
 *   npm run test:db
 */
const connected = Boolean(process.env.DATABASE_URL);

/** Audit rows cannot be cleaned up afterwards, so each run tags its own. */
const RUN = `pgtest-${Date.now()}`;

describe.skipIf(!connected)("Postgres layer", () => {
  beforeEach(async () => {
    // Users cascade to almost everything, so clearing them resets the fixtures.
    // audit_log is deliberately absent: it is append-only, by design, even here.
    await run("DELETE FROM users WHERE id LIKE 'pgtest-%'");
  });

  afterAll(async () => {
    await run("DELETE FROM users WHERE id LIKE 'pgtest-%'");
    await closePool();
  });

  async function makeUser(id: string, email = `${id}@krave.test`) {
    await run(
      `INSERT INTO users (id, email, display_name, password_hash, password_salt, created_at)
       VALUES ($1, $2, 'Test', 'hash', 'salt', $3)`,
      [id, email, new Date().toISOString()]
    );
  }

  it("round-trips rows and reports how many were touched", async () => {
    await makeUser("pgtest-a");

    const found = await one<{ email: string }>("SELECT email FROM users WHERE id = $1", [
      "pgtest-a",
    ]);
    expect(found?.email).toBe("pgtest-a@krave.test");

    expect(await one("SELECT 1 FROM users WHERE id = $1", ["pgtest-missing"])).toBeUndefined();

    // Guarded updates rely on this to tell a real change from a no-op.
    expect(await run("UPDATE users SET display_name = 'X' WHERE id = $1", ["pgtest-a"])).toBe(1);
    expect(await run("UPDATE users SET display_name = 'X' WHERE id = $1", ["pgtest-none"])).toBe(0);
  });

  it("keeps integers as numbers rather than strings", async () => {
    await makeUser("pgtest-num");
    // pg returns BIGINT as a string; the stores read these with Number(), so INTEGER
    // columns must not arrive as text or comparisons would silently fail.
    const row = await one<{ is_gold_member: number }>(
      "SELECT is_gold_member FROM users WHERE id = $1",
      ["pgtest-num"]
    );
    expect(typeof row?.is_gold_member).toBe("number");
    expect(row?.is_gold_member).toBe(0);
  });

  it("enforces the partial unique index used for idempotent checkout", async () => {
    await makeUser("pgtest-idem");
    const insertOrder = (id: string, key: string | null) =>
      run(
        `INSERT INTO orders (id, user_id, res_id, address_id, payment_method, is_gold_member,
           rider_tip, scheduled_slot, due_at, stage, grand_total, placed_at, idempotency_key)
         VALUES ($1, 'pgtest-idem', 1, 'addr', 'UPI (demo)', 0, 0, 'ASAP', $2, 'ORDER_CONFIRMED',
           100, $2, $3)`,
        [id, new Date().toISOString(), key]
      );

    await insertOrder("pgtest-ord-1", "key-1");
    await expect(insertOrder("pgtest-ord-2", "key-1")).rejects.toThrow();

    // NULL keys must stay exempt, or guest orders could only ever be placed once.
    await insertOrder("pgtest-ord-3", null);
    await insertOrder("pgtest-ord-4", null);
  });

  it("supports ON CONFLICT and RETURNING", async () => {
    await makeUser("pgtest-conflict");
    const stamp = new Date().toISOString();

    await run(
      `INSERT INTO dish_availability (outlet_id, item_id, marked_at, marked_by)
       VALUES (1, 'dish', $1, 'pgtest-conflict')
       ON CONFLICT (outlet_id, item_id) DO UPDATE SET marked_at = excluded.marked_at`,
      [stamp]
    );
    const second = await run(
      `INSERT INTO dish_availability (outlet_id, item_id, marked_at, marked_by)
       VALUES (1, 'dish', $1, 'pgtest-conflict')
       ON CONFLICT (outlet_id, item_id) DO UPDATE SET marked_at = excluded.marked_at`,
      ["later"]
    );
    expect(second).toBe(1);

    const returned = await one<{ item_id: string }>(
      `INSERT INTO bookmarks (user_id, res_id) VALUES ('pgtest-conflict', 99)
       ON CONFLICT DO NOTHING RETURNING res_id AS item_id`
    );
    expect(returned).toBeDefined();
  });

  it("cascades deletes, so removing a user clears their data", async () => {
    await makeUser("pgtest-cascade");
    await run("INSERT INTO bookmarks (user_id, res_id) VALUES ('pgtest-cascade', 7)");

    await run("DELETE FROM users WHERE id = 'pgtest-cascade'");
    expect(await rows("SELECT 1 FROM bookmarks WHERE user_id = 'pgtest-cascade'")).toHaveLength(0);
  });

  it("rolls a failed transaction back completely", async () => {
    await makeUser("pgtest-tx");

    await expect(
      transaction(async (client) => {
        await client.query("INSERT INTO bookmarks (user_id, res_id) VALUES ('pgtest-tx', 1)");
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    expect(await rows("SELECT 1 FROM bookmarks WHERE user_id = 'pgtest-tx'")).toHaveLength(0);

    await transaction(async (client) => {
      await client.query("INSERT INTO bookmarks (user_id, res_id) VALUES ('pgtest-tx', 2)");
    });
    expect(await rows("SELECT 1 FROM bookmarks WHERE user_id = 'pgtest-tx'")).toHaveLength(1);
  });

  it("keeps the audit log append-only on the real server", async () => {
    await run(
      `INSERT INTO audit_log (actor_id, action, subject, detail, at)
       VALUES ($1, 'TEST', $2, 'detail', $3)`,
      [RUN, `${RUN}-subject`, new Date().toISOString()]
    );

    await expect(
      run("UPDATE audit_log SET detail = 'tampered' WHERE actor_id = $1", [RUN])
    ).rejects.toThrow(/append-only/i);
    await expect(run("DELETE FROM audit_log WHERE actor_id = $1", [RUN])).rejects.toThrow(
      /append-only/i
    );

    // TRUNCATE skips row-level triggers, so it needs its own guard or the two
    // checks above are one statement away from being worthless.
    await expect(run("TRUNCATE audit_log")).rejects.toThrow(/append-only/i);

    // The row is still there after all three attempts.
    expect(await rows("SELECT 1 FROM audit_log WHERE actor_id = $1", [RUN])).toHaveLength(1);
  });

  it("sorts ISO timestamp text chronologically", async () => {
    await makeUser("pgtest-sort");
    // The schema keeps timestamps as text; ordering only works if they sort lexically.
    for (const [id, at] of [
      ["n1", "2026-01-02T10:00:00.000Z"],
      ["n2", "2026-01-10T09:00:00.000Z"],
      ["n3", "2026-01-02T09:00:00.000Z"],
    ]) {
      await run(
        `INSERT INTO notifications (id, user_id, kind, title, body, created_at)
         VALUES ($1, 'pgtest-sort', 'SYSTEM', 't', 'b', $2)`,
        [`pgtest-${id}`, at]
      );
    }

    const ordered = await rows<{ id: string }>(
      "SELECT id FROM notifications WHERE user_id = 'pgtest-sort' ORDER BY created_at DESC"
    );
    expect(ordered.map((row) => row.id)).toEqual(["pgtest-n2", "pgtest-n1", "pgtest-n3"]);
  });
});
