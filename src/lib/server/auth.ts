import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { DatabaseFault, one, run, transaction } from "./pg";
import { hasAssignedStaffAccess } from "./staff";
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  RESET_LINK_MINUTES,
} from "@/lib/passwordReset";
import { DELETE_CONFIRMATION_WORD } from "@/lib/accountRules";

const scryptAsync = promisify(scrypt) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number
) => Promise<Buffer>;

export const SESSION_COOKIE = "krave_session";
const SESSION_DAYS = 30;
const KEY_LENGTH = 64;

/** Throttling is per email and per client address, so one does not mask the other. */
export const MAX_LOGIN_ATTEMPTS = 5;
/**
 * Far higher than the per-account limit on purpose. Many users share one address behind a
 * NAT or carrier, so a single attacker must not be able to lock all of them out; this ceiling
 * only catches credential stuffing sprayed across many accounts from one source.
 */
export const MAX_CLIENT_LOGIN_ATTEMPTS = 60;
export const LOGIN_WINDOW_MINUTES = 15;
/**
 * Unauthenticated writes per client address per window. Generous, because a classroom or
 * office shares one address, but a script can no longer fill the database or burn CPU on
 * password hashes from one machine.
 */
export const MAX_SIGNUPS_PER_CLIENT = 30;
export const MAX_GUEST_ORDERS_PER_CLIENT = 30;
/** Enough to retry a slow or spam-filtered email, too few to flood someone's inbox. */
export const MAX_RESET_EMAILS_PER_ADDRESS = 3;
export const MAX_RESET_REQUESTS_PER_CLIENT = 10;

export const RESET_LINK_INVALID = "That reset link is not valid.";
export const RESET_LINK_SPENT = "That reset link has expired or was already used.";

export const WRONG_CURRENT_PASSWORD = "Your current password is incorrect.";
export const REAUTH_THROTTLED = `Too many wrong passwords. Try again in ${LOGIN_WINDOW_MINUTES} minutes.`;
export const SAME_PASSWORD = "Choose a password different from your current one.";
export const PASSWORD_CHANGED_ELSEWHERE =
  "Your password was just changed on another device. Sign in again with the new one.";
export const DELETE_BLOCKED_BY_STAFF_ACCESS =
  "This account has staff access. Ask whoever granted it to remove it first, so the outlet's records stay intact.";
export const DELETE_BLOCKED_BY_RESTAURANT =
  "This account still owns a restaurant. Transfer or delete the restaurant first, then try again.";

export interface AccountUser {
  id: string;
  email: string;
  displayName: string;
  isGoldMember: boolean;
  phone: string | null;
  emailVerified: boolean;
}

export function normalizeEmail(value: unknown): string {
  const email = typeof value === "string" ? value.trim().toLowerCase() : "";
  // Deliberately permissive: enough structure to be a mailbox, no attempt to prove delivery.
  if (email.length < 5 || email.length > 160 || !/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
    throw new Error("Enter a valid email address.");
  }
  return email;
}

function assertPassword(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < PASSWORD_MIN_LENGTH ||
    value.length > PASSWORD_MAX_LENGTH
  ) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  return value;
}

async function hashPassword(password: string, salt: string): Promise<string> {
  const derived = await scryptAsync(password, salt, KEY_LENGTH);
  return derived.toString("hex");
}

/** Session tokens are stored hashed, so a database copy cannot be replayed as a login. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The Postgres error code behind a driver failure, e.g. 23505 for a unique violation. */
export function databaseErrorCode(error: unknown): string | null {
  if (!(error instanceof DatabaseFault)) return null;
  const code = (error.cause as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
}

export function rowToUser(row: Record<string, unknown>): AccountUser {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: String(row.display_name),
    isGoldMember: Number(row.is_gold_member) === 1,
    phone: typeof row.phone === "string" ? row.phone : null,
    emailVerified: row.email_verified_at !== null && row.email_verified_at !== undefined,
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
  limits: ReadonlyArray<readonly [key: string, limit: number]>,
  refusal = `Too many sign-in attempts. Try again in ${LOGIN_WINDOW_MINUTES} minutes.`
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

    const since = windowStart();
    const counted = await client.query(
      `SELECT attempt_key, COUNT(*)::int AS failures FROM login_attempts
       WHERE attempt_key = ANY($1::text[]) AND succeeded = 0 AND attempted_at > $2
       GROUP BY attempt_key`,
      [keys, since]
    );
    const failures = new Map<string, number>(
      counted.rows.map((row) => [String(row.attempt_key), Number(row.failures)])
    );
    for (const [key, limit] of limits) {
      if ((failures.get(key) ?? 0) >= limit) {
        throw new Error(refusal);
      }
    }

    // Rows that have aged out of the window are dropped in the same statement, so a public
    // deployment's table stays bounded by recent traffic instead of growing forever.
    const inserted = await client.query(
      `WITH expired AS (
         DELETE FROM login_attempts WHERE attempt_key = ANY($1::text[]) AND attempted_at <= $3
       )
       INSERT INTO login_attempts (attempt_key, attempted_at, succeeded)
       SELECT k, $2, 0 FROM unnest($1::text[]) AS k
       RETURNING id`,
      [keys, new Date().toISOString(), since]
    );
    return inserted.rows.map((row) => Number(row.id));
  });
}

async function settleLoginSuccess(reservedIds: number[], accountKey: string): Promise<void> {
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
    [reservedIds, accountKey]
  );
}

/**
 * Counts one unauthenticated write against a client's quota, refusing once it is spent.
 * Every attempt counts, successful or not, so the quota bounds writes rather than errors.
 */
export async function reserveClientQuota(
  key: string,
  limit: number,
  refusal: string
): Promise<void> {
  await reserveLoginAttempt([[key, limit]], refusal);
}

/**
 * Counts a reset request against the address and the client before anything else happens,
 * whether or not an account exists, so hitting the limit says nothing about which do.
 */
export async function reservePasswordResetRequest(
  email: string,
  clientKey: string
): Promise<void> {
  await reserveLoginAttempt(
    [
      [`reset:${email}`, MAX_RESET_EMAILS_PER_ADDRESS],
      [`reset-client:${clientKey}`, MAX_RESET_REQUESTS_PER_CLIENT],
    ],
    `Too many reset requests. Try again in ${LOGIN_WINDOW_MINUTES} minutes.`
  );
}

export async function registerUser(
  input: unknown,
  clientKey: string | null = null
): Promise<AccountUser> {
  const body = (input ?? {}) as Record<string, unknown>;
  const email = normalizeEmail(body.email);
  const password = assertPassword(body.password);
  const displayName =
    typeof body.displayName === "string" && body.displayName.trim().length >= 2
      ? body.displayName.trim().slice(0, 60)
      : email.split("@")[0].slice(0, 60);

  // Reserved before the deliberately slow hash, for the same reason as sign-in.
  if (clientKey) {
    await reserveClientQuota(
      `signup:${clientKey}`,
      MAX_SIGNUPS_PER_CLIENT,
      `Too many new accounts from this network. Try again in ${LOGIN_WINDOW_MINUTES} minutes.`
    );
  }

  const salt = randomBytes(16).toString("hex");
  const user: AccountUser = {
    id: `usr_${randomUUID()}`,
    email,
    displayName,
    isGoldMember: false,
    phone: null,
    emailVerified: false,
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

  await settleLoginSuccess(reserved, `email:${email}`);
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
 * identically either way and account existence stays unguessable. Delivering it is the
 * caller's job (see passwordResetMail.ts).
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
  const expiresAt = new Date(Date.now() + RESET_LINK_MINUTES * 60 * 1000);

  await transaction(async (client) => {
    // Two requests at once would each delete before either inserts, leaving both links
    // live. Taken alone, before the DELETE, so the DELETE reads after the other committed.
    // An advisory lock, not the user row: resetPassword locks the link then the user, and
    // taking them here in the other order could deadlock.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `password-reset:${String(row.id)}`,
    ]);
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

/** Resolves with the account's email, so its owner can be told the password changed. */
export async function resetPassword(
  token: unknown,
  newPassword: unknown,
  clientKey = "unknown-client"
): Promise<{ email: string | null }> {
  if (typeof token !== "string" || token.length < 20) {
    throw new Error(RESET_LINK_INVALID);
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
    throw new Error(RESET_LINK_SPENT);
  }

  const salt = randomBytes(16).toString("hex");
  const hash = await hashPassword(password, salt);

  return transaction(async (client) => {
    // Claimed atomically after the slow hash: a concurrent reset with the same token, or a
    // newer token issued meanwhile (which deletes this one), must make this attempt fail.
    const now = new Date().toISOString();
    const claimedRows = await client.query(
      "UPDATE password_resets SET used_at = $1 WHERE token_hash = $2 AND used_at IS NULL AND expires_at > $3 RETURNING user_id",
      [now, tokenHash, now]
    );
    const claimed = claimedRows.rows[0] as Record<string, unknown> | undefined;
    if (!claimed) {
      throw new Error(RESET_LINK_SPENT);
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
    return { email: owner ? String(owner.email) : null };
  });
}

/**
 * Re-checks a signed-in user's password before a sensitive change. Throttled per account and
 * per client like sign-in, so a stolen session cannot be used to guess the password.
 */
async function confirmCurrentPassword(
  userId: string,
  password: unknown,
  clientKey: string
): Promise<{ user: AccountUser; passwordHash: string }> {
  const reserved = await reserveLoginAttempt(
    [
      [`reauth:${userId}`, MAX_LOGIN_ATTEMPTS],
      [`client:${clientKey}`, MAX_CLIENT_LOGIN_ATTEMPTS],
    ],
    REAUTH_THROTTLED
  );
  const row = await one<Record<string, unknown>>("SELECT * FROM users WHERE id = $1", [userId]);
  const salt = row ? String(row.password_salt) : randomBytes(16).toString("hex");
  const candidate = Buffer.from(
    await hashPassword(typeof password === "string" ? password : "", salt),
    "hex"
  );
  const expected = row
    ? Buffer.from(String(row.password_hash), "hex")
    : Buffer.alloc(candidate.length);
  if (!row || candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
    throw new Error(WRONG_CURRENT_PASSWORD);
  }
  await settleLoginSuccess(reserved, `reauth:${userId}`);
  return { user: rowToUser(row), passwordHash: String(row.password_hash) };
}

export async function verifyAccountPassword(
  userId: string,
  password: unknown,
  clientKey = "unknown-client"
): Promise<AccountUser> {
  return (await confirmCurrentPassword(userId, password, clientKey)).user;
}

/** A short secret other than the password (the table POS owner PIN), stored as `salt:hash`. */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${await hashPassword(secret, salt)}`;
}

/**
 * Checks a short secret against its stored hash, throttled under `key` like sign-in: a 4-digit
 * PIN has only 10,000 values, so unthrottled it could be walked in minutes.
 */
export async function checkThrottledSecret(
  key: string,
  secret: string,
  stored: string,
  refusal: string
): Promise<boolean> {
  const reserved = await reserveLoginAttempt([[key, MAX_LOGIN_ATTEMPTS]], refusal);
  const [salt, expectedHex] = stored.split(":");
  const candidate = Buffer.from(await hashPassword(secret, salt ?? ""), "hex");
  const expected = Buffer.from(expectedHex ?? "", "hex");
  const matches = candidate.length === expected.length && timingSafeEqual(candidate, expected);
  if (matches) await settleLoginSuccess(reserved, key);
  return matches;
}

/**
 * Sets a new password for a signed-in user. Other devices are signed out and unused reset
 * links stop working; the device that made the change stays signed in.
 */
export async function changePassword(
  userId: string,
  sessionToken: string | undefined,
  input: unknown,
  clientKey = "unknown-client"
): Promise<AccountUser> {
  const body = (input ?? {}) as Record<string, unknown>;
  const next = assertPassword(body.newPassword);
  if (body.currentPassword === next) throw new Error(SAME_PASSWORD);
  const { user, passwordHash } = await confirmCurrentPassword(
    userId,
    body.currentPassword,
    clientKey
  );

  const salt = randomBytes(16).toString("hex");
  const hash = await hashPassword(next, salt);
  await transaction(async (client) => {
    // Conditional on the hash just checked, so a change or reset that landed during the
    // slow hash is not silently overwritten.
    const updated = await client.query(
      "UPDATE users SET password_hash = $1, password_salt = $2 WHERE id = $3 AND password_hash = $4",
      [hash, salt, userId, passwordHash]
    );
    if (updated.rowCount !== 1) throw new Error(PASSWORD_CHANGED_ELSEWHERE);
    await client.query("DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2", [
      userId,
      sessionToken ? hashToken(sessionToken) : "",
    ]);
    // A reset link sent before the change must not be able to undo it.
    await client.query("DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL", [
      userId,
    ]);
  });
  return user;
}

/** Deletes the signed-in account and everything it owns. Resolves with who it was. */
export async function deleteAccount(
  userId: string,
  input: unknown,
  clientKey = "unknown-client"
): Promise<AccountUser> {
  const body = (input ?? {}) as Record<string, unknown>;
  if (
    typeof body.confirmation !== "string" ||
    body.confirmation.trim() !== DELETE_CONFIRMATION_WORD
  ) {
    throw new Error(`Type ${DELETE_CONFIRMATION_WORD} to confirm.`);
  }
  const user = await verifyAccountPassword(userId, body.password, clientKey);
  // Staff marks (sold-out dishes, shifts) belong to the outlet, and would go with the account.
  if (await hasAssignedStaffAccess(user)) throw new Error(DELETE_BLOCKED_BY_STAFF_ACCESS);
  try {
    await run("DELETE FROM users WHERE id = $1", [userId]);
  } catch (error) {
    // A table that must keep its user (a restaurant's owner) refuses the delete: RESTRICT
    // reports 23001, the default NO ACTION 23503.
    const code = databaseErrorCode(error);
    if (code === "23001" || code === "23503") {
      throw new Error(DELETE_BLOCKED_BY_RESTAURANT, { cause: error });
    }
    throw error;
  }
  return user;
}
