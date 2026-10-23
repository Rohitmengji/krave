import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { one, run, transaction } from "./pg";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number
) => Promise<Buffer>;

export const SESSION_COOKIE = "krave_session";
const SESSION_DAYS = 30;
const KEY_LENGTH = 64;
const MIN_PASSWORD_LENGTH = 10;

/** Throttling is per email and per client address, so one does not mask the other. */
export const MAX_LOGIN_ATTEMPTS = 5;
/**
 * Far higher than the per-account limit on purpose. Many users share one address behind a
 * NAT or carrier, so a single attacker must not be able to lock all of them out; this ceiling
 * only catches credential stuffing sprayed across many accounts from one source.
 */
export const MAX_CLIENT_LOGIN_ATTEMPTS = 60;
export const LOGIN_WINDOW_MINUTES = 15;
const RESET_TOKEN_MINUTES = 30;

export interface AccountUser {
  id: string;
  email: string;
  displayName: string;
  isGoldMember: boolean;
}

function normalizeEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  // Deliberately permissive: enough structure to be a mailbox, no attempt to prove delivery.
  if (email.length < 5 || email.length > 160 || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    throw new Error("Enter a valid email address.");
  }
  return email;
}

function assertPassword(value: unknown): string {
  if (typeof value !== "string" || value.length < MIN_PASSWORD_LENGTH || value.length > 200) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  return value;
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return derived.toString("hex");
}

/** Session tokens are stored hashed, so a database copy cannot be replayed as a login. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function rowToUser(row: Record<string, unknown>): AccountUser {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    isGoldMember: Number(row.is_gold_member) === 1,
  };
}

function windowStart(): string {
  return new Date(Date.now() - LOGIN_WINDOW_MINUTES * 60 * 1000).toISOString();
}

/**
 * Check every limit and count this attempt as a failure in one transaction, *before* the slow
 * password hash. Checking first and recording after the `await` let a burst of concurrent
 * requests all pass the check while their hashes were queued: 500 parallel guesses, not 8.
 * Returns the reserved row ids so a success can be marked afterwards.
 *
 * Every statement here is a network round trip, so each step is one query for all keys.
 */
async function reserveLoginAttempt(
  limits: ReadonlyArray<readonly [key: string, limit: number]>
): Promise<number[]> {
  const keys = limits.map(([key]) => key);
  return transaction(async (client) => {
    // Serialises concurrent attempts for these keys, which is what stops a burst of
    // parallel requests all passing the count check before any of them records a failure.
    // Sorted, so two requests sharing keys always lock them in the same order.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext(k)) FROM unnest($1::text[]) AS k ORDER BY k",
      [[...keys].sort()]
    );

    const counted = await client.query(
      `SELECT attempt_key, COUNT(*)::int AS failures FROM login_attempts
       WHERE attempt_key = ANY($1::text[]) AND succeeded = 0 AND attempted_at > $2
       GROUP BY attempt_key`,
      [keys, windowStart()]
    );
    const failures = new Map<string, number>(
      counted.rows.map((row) => [String(row.attempt_key), Number(row.failures)])
    );
    for (const [key, limit] of limits) {
      if ((failures.get(key) ?? 0) >= limit) {
        throw new Error(
          `Too many sign-in attempts. Try again in ${LOGIN_WINDOW_MINUTES} minutes.`
        );
      }
    }

    const inserted = await client.query(
      `INSERT INTO login_attempts (attempt_key, attempted_at, succeeded)
       SELECT k, $2, 0 FROM unnest($1::text[]) AS k
       RETURNING id`,
      [keys, new Date().toISOString()]
    );
    return inserted.rows.map((row) => Number(row.id));
  });
}

async function settleLoginSuccess(reservedIds: number[], email: string): Promise<void> {
  // One statement, so it is atomic without a transaction's extra round trips.
  // A success clears the account's streak so a legitimate user is not punished for earlier
  // typos. Client failures are left to age out: an attacker spraying many accounts could
  // otherwise sign in to their own account to wipe the client counter and keep going.
  await run(
    `WITH marked AS (
       UPDATE login_attempts SET succeeded = 1 WHERE id = ANY($1::bigint[]) RETURNING id
     )
     DELETE FROM login_attempts
     WHERE attempt_key = $2 AND succeeded = 0 AND id <> ALL(SELECT id FROM marked)`,
    [reservedIds, `email:${email}`]
  );
}

export async function registerUser(input: unknown): Promise<AccountUser> {
  const body = (input ?? {}) as Record<string, unknown>;
  const email = normalizeEmail(body.email);
  const password = assertPassword(body.password);
  const displayName =
    typeof body.displayName === "string" && body.displayName.trim().length >= 2
      ? body.displayName.trim().slice(0, 60)
      : email.split("@")[0].slice(0, 60);

  const salt = randomBytes(16).toString("hex");
  const user = {
    id: `usr_${randomUUID()}`,
    email,
    displayName,
    isGoldMember: false,
  };

  // The UNIQUE index decides, not a prior SELECT: two simultaneous signups for the same
  // address would both pass a check-then-insert.
  const inserted = await run(
    `INSERT INTO users (id, email, display_name, password_hash, password_salt, is_gold_member, created_at)
     VALUES ($1, $2, $3, $4, $5, 0, $6)
     ON CONFLICT (email) DO NOTHING`,
    [user.id, email, displayName, await hashPassword(password, salt), salt, new Date().toISOString()]
  );
  if (inserted === 0) {
    throw new Error("An account already exists for that email.");
  }

  return user;
}

export async function verifyCredentials(
  input: unknown,
  clientKey = "unknown-client"
): Promise<AccountUser> {
  const body = (input ?? {}) as Record<string, unknown>;
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";

  const reserved = await reserveLoginAttempt([
    [`email:${email}`, MAX_LOGIN_ATTEMPTS],
    [`client:${clientKey}`, MAX_CLIENT_LOGIN_ATTEMPTS],
  ]);

  const row = await one<Record<string, unknown>>("SELECT * FROM users WHERE email = $1", [email]);

  // Hash even when the email is unknown so a missing account is not faster to probe.
  const salt = row ? String(row.password_salt) : randomBytes(16).toString("hex");
  const candidate = Buffer.from(await hashPassword(password, salt), "hex");
  const expected = row
    ? Buffer.from(String(row.password_hash), "hex")
    : Buffer.alloc(candidate.length);

  const matches =
    candidate.length === expected.length && timingSafeEqual(candidate, expected);
  if (!row || !matches) {
    // The reserved rows already count as failures.
    throw new Error("Email or password is incorrect.");
  }

  await settleLoginSuccess(reserved, email);
  return rowToUser(row);
}

export async function createSession(
  userId: string
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await run(
    "INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)",
    [hashToken(token), userId, new Date().toISOString(), expiresAt.toISOString()]
  );
  return { token, expiresAt };
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (!token) return;
  await run("DELETE FROM sessions WHERE token_hash = $1", [hashToken(token)]);
}

export async function getUserForToken(token: string | undefined): Promise<AccountUser | null> {
  if (!token) return null;
  const row = await one<Record<string, unknown>>(
    `SELECT users.* FROM sessions
     JOIN users ON users.id = sessions.user_id
     WHERE sessions.token_hash = $1 AND sessions.expires_at > $2`,
    [hashToken(token), new Date().toISOString()]
  );
  return row ? rowToUser(row) : null;
}

export async function setGoldMembership(userId: string, isGoldMember: boolean): Promise<void> {
  await run("UPDATE users SET is_gold_member = $1 WHERE id = $2", [
    isGoldMember ? 1 : 0,
    userId,
  ]);
}

export async function revokeAllSessions(userId: string): Promise<void> {
  await run("DELETE FROM sessions WHERE user_id = $1", [userId]);
}

/**
 * Issue a reset token. Returns null for an unknown address so the caller can answer
 * identically either way and account existence stays unguessable. There is no mail
 * provider here, so the caller is responsible for delivering the token out of band.
 */
export async function createPasswordReset(
  input: unknown
): Promise<{ token: string; expiresAt: Date } | null> {
  const body = (input ?? {}) as Record<string, unknown>;
  let email: string;
  try {
    email = normalizeEmail(body.email);
  } catch {
    return null;
  }

  const row = await one<Record<string, unknown>>("SELECT id FROM users WHERE email = $1", [email]);
  if (!row) return null;

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_MINUTES * 60 * 1000);

  await transaction(async (client) => {
    // Only the newest token should work, so earlier unused ones are discarded.
    await client.query("DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL", [
      String(row.id),
    ]);
    await client.query(
      "INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, used_at) VALUES ($1, $2, $3, $4, NULL)",
      [hashToken(token), String(row.id), new Date().toISOString(), expiresAt.toISOString()]
    );
  });

  return { token, expiresAt };
}

export async function resetPassword(
  token: unknown,
  newPassword: unknown,
  clientKey = "unknown-client"
): Promise<void> {
  if (typeof token !== "string" || token.length < 20) {
    throw new Error("That reset link is not valid.");
  }
  const password = assertPassword(newPassword);

  const tokenHash = hashToken(token);
  // Cheap pre-check so an invalid link is refused without paying for a hash. It is not the
  // authority: the claim inside the transaction below is.
  const pending = await one(
    "SELECT 1 FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2",
    [tokenHash, new Date().toISOString()]
  );
  if (!pending) {
    throw new Error("That reset link has expired or was already used.");
  }

  const salt = randomBytes(16).toString("hex");
  const hash = await hashPassword(password, salt);

  await transaction(async (client) => {
    // Claimed atomically after the slow hash: a concurrent reset with the same token, or a
    // newer token issued meanwhile (which deletes this one), must make this attempt fail.
    const now = new Date().toISOString();
    const claimedRows = await client.query(
      "UPDATE password_resets SET used_at = $1 WHERE token_hash = $2 AND used_at IS NULL AND expires_at > $3 RETURNING user_id",
      [now, tokenHash, now]
    );
    const claimed = claimedRows.rows[0] as Record<string, unknown> | undefined;
    if (!claimed) {
      throw new Error("That reset link has expired or was already used.");
    }
    const userId = String(claimed.user_id);
    const ownerRows = await client.query("SELECT email FROM users WHERE id = $1", [userId]);
    const owner = ownerRows.rows[0] as Record<string, unknown> | undefined;

    await client.query("UPDATE users SET password_hash = $1, password_salt = $2 WHERE id = $3", [
      hash,
      salt,
      userId,
    ]);
    // A reset is also how a user recovers a stolen session, so every device is signed out.
    await client.query("DELETE FROM sessions WHERE user_id = $1", [userId]);
    // Holding a valid token proves mailbox control, so the lockout that blocked them is lifted.
    if (owner) {
      await client.query("DELETE FROM login_attempts WHERE attempt_key = $1", [
        `email:${String(owner.email)}`,
      ]);
    }
    await client.query("DELETE FROM login_attempts WHERE attempt_key = $1", [
      `client:${clientKey}`,
    ]);
  });
}
