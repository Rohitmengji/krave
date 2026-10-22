import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getDb } from "./db";

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
export const MAX_LOGIN_ATTEMPTS = 8;
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

function assertNotThrottled(attemptKey: string, limit = MAX_LOGIN_ATTEMPTS): void {
  const row = getDb()
    .prepare(
      "SELECT COUNT(*) AS failures FROM login_attempts WHERE attempt_key = ? AND succeeded = 0 AND attempted_at > ?"
    )
    .get(attemptKey, windowStart()) as Record<string, unknown>;
  if (Number(row.failures) >= limit) {
    throw new Error(
      `Too many sign-in attempts. Try again in ${LOGIN_WINDOW_MINUTES} minutes.`
    );
  }
}

/**
 * Check every limit and count this attempt as a failure in one transaction, *before* the slow
 * password hash. Checking first and recording after the `await` let a burst of concurrent
 * requests all pass the check while their hashes were queued: 500 parallel guesses, not 8.
 * Returns the reserved row ids so a success can be marked afterwards.
 */
function reserveLoginAttempt(limits: ReadonlyArray<readonly [key: string, limit: number]>): number[] {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [key, limit] of limits) assertNotThrottled(key, limit);
    const insert = db.prepare(
      "INSERT INTO login_attempts (attempt_key, attempted_at, succeeded) VALUES (?, ?, 0)"
    );
    const now = new Date().toISOString();
    const ids = limits.map(([key]) => Number(insert.run(key, now).lastInsertRowid));
    db.exec("COMMIT");
    return ids;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function settleLoginSuccess(reservedIds: number[], email: string): void {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const mark = db.prepare("UPDATE login_attempts SET succeeded = 1 WHERE id = ?");
    for (const id of reservedIds) mark.run(id);
    // A success clears the account's streak so a legitimate user is not punished for earlier
    // typos. Client failures are left to age out: an attacker spraying many accounts could
    // otherwise sign in to their own account to wipe the client counter and keep going.
    db.prepare("DELETE FROM login_attempts WHERE attempt_key = ? AND succeeded = 0").run(`email:${email}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export async function registerUser(input: unknown): Promise<AccountUser> {
  const body = (input ?? {}) as Record<string, unknown>;
  const email = normalizeEmail(body.email);
  const password = assertPassword(body.password);
  const displayName =
    typeof body.displayName === "string" && body.displayName.trim().length >= 2
      ? body.displayName.trim().slice(0, 60)
      : email.split("@")[0].slice(0, 60);

  const db = getDb();
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(email)) {
    throw new Error("An account already exists for that email.");
  }

  const salt = randomBytes(16).toString("hex");
  const user = {
    id: `usr_${randomUUID()}`,
    email,
    displayName,
    isGoldMember: false,
  };
  db.prepare(
    `INSERT INTO users (id, email, display_name, password_hash, password_salt, is_gold_member, created_at)
     VALUES (?, ?, ?, ?, ?, 0, ?)`
  ).run(user.id, email, displayName, await hashPassword(password, salt), salt, new Date().toISOString());

  return user;
}

export async function verifyCredentials(
  input: unknown,
  clientKey = "unknown-client"
): Promise<AccountUser> {
  const body = (input ?? {}) as Record<string, unknown>;
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";

  const reserved = reserveLoginAttempt([
    [`email:${email}`, MAX_LOGIN_ATTEMPTS],
    [`client:${clientKey}`, MAX_CLIENT_LOGIN_ATTEMPTS],
  ]);

  const row = getDb()
    .prepare("SELECT * FROM users WHERE email = ?")
    .get(email) as Record<string, unknown> | undefined;

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

  settleLoginSuccess(reserved, email);
  return rowToUser(row);
}

export function createSession(userId: string): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  getDb()
    .prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(hashToken(token), userId, new Date().toISOString(), expiresAt.toISOString());
  return { token, expiresAt };
}

export function destroySession(token: string | undefined): void {
  if (!token) return;
  getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}

export function getUserForToken(token: string | undefined): AccountUser | null {
  if (!token) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT users.* FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ?`
    )
    .get(hashToken(token), new Date().toISOString()) as Record<string, unknown> | undefined;
  return row ? rowToUser(row) : null;
}

export function setGoldMembership(userId: string, isGoldMember: boolean): void {
  getDb()
    .prepare("UPDATE users SET is_gold_member = ? WHERE id = ?")
    .run(isGoldMember ? 1 : 0, userId);
}

export function revokeAllSessions(userId: string): void {
  getDb().prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
}

/**
 * Issue a reset token. Returns null for an unknown address so the caller can answer
 * identically either way and account existence stays unguessable. There is no mail
 * provider here, so the caller is responsible for delivering the token out of band.
 */
export function createPasswordReset(
  input: unknown
): { token: string; expiresAt: Date } | null {
  const body = (input ?? {}) as Record<string, unknown>;
  let email: string;
  try {
    email = normalizeEmail(body.email);
  } catch {
    return null;
  }

  const db = getDb();
  const row = db.prepare("SELECT id FROM users WHERE email = ?").get(email) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;

  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + RESET_TOKEN_MINUTES * 60 * 1000);
  // Only the newest token should work, so earlier unused ones are discarded.
  db.prepare("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL").run(String(row.id));
  db.prepare(
    "INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, NULL)"
  ).run(hashToken(token), String(row.id), new Date().toISOString(), expiresAt.toISOString());

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

  const db = getDb();
  const tokenHash = hashToken(token);
  // Cheap pre-check so an invalid link is refused without paying for a hash. It is not the
  // authority: the claim inside the transaction below is.
  const pending = db
    .prepare("SELECT 1 FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .get(tokenHash, new Date().toISOString());
  if (!pending) {
    throw new Error("That reset link has expired or was already used.");
  }

  const salt = randomBytes(16).toString("hex");
  const hash = await hashPassword(password, salt);

  db.exec("BEGIN IMMEDIATE");
  try {
    // Claimed atomically after the slow hash: a concurrent reset with the same token, or a
    // newer token issued meanwhile (which deletes this one), must make this attempt fail.
    const now = new Date().toISOString();
    const claimed = db
      .prepare(
        "UPDATE password_resets SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ? RETURNING user_id"
      )
      .get(now, tokenHash, now) as Record<string, unknown> | undefined;
    if (!claimed) {
      throw new Error("That reset link has expired or was already used.");
    }
    const userId = String(claimed.user_id);
    const owner = db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as
      | Record<string, unknown>
      | undefined;
    db.prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?").run(
      hash,
      salt,
      userId
    );
    // A reset is also how a user recovers a stolen session, so every device is signed out.
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    // Holding a valid token proves mailbox control, so the lockout that blocked them is lifted.
    if (owner) {
      db.prepare("DELETE FROM login_attempts WHERE attempt_key = ?").run(`email:${String(owner.email)}`);
    }
    db.prepare("DELETE FROM login_attempts WHERE attempt_key = ?").run(`client:${clientKey}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
