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

function recordLoginAttempt(attemptKey: string, succeeded: boolean): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO login_attempts (attempt_key, attempted_at, succeeded) VALUES (?, ?, ?)"
  ).run(attemptKey, new Date().toISOString(), succeeded ? 1 : 0);
  // A success clears the streak so a legitimate user is not punished for earlier typos.
  if (succeeded) {
    db.prepare("DELETE FROM login_attempts WHERE attempt_key = ? AND succeeded = 0").run(attemptKey);
  }
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

  assertNotThrottled(`email:${email}`);
  assertNotThrottled(`client:${clientKey}`, MAX_CLIENT_LOGIN_ATTEMPTS);

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
    recordLoginAttempt(`email:${email}`, false);
    recordLoginAttempt(`client:${clientKey}`, false);
    throw new Error("Email or password is incorrect.");
  }

  recordLoginAttempt(`email:${email}`, true);
  recordLoginAttempt(`client:${clientKey}`, true);
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
  const row = db
    .prepare("SELECT * FROM password_resets WHERE token_hash = ?")
    .get(hashToken(token)) as Record<string, unknown> | undefined;
  if (!row || row.used_at !== null || String(row.expires_at) <= new Date().toISOString()) {
    throw new Error("That reset link has expired or was already used.");
  }

  const salt = randomBytes(16).toString("hex");
  const hash = await hashPassword(password, salt);
  const userId = String(row.user_id);
  const owner = db.prepare("SELECT email FROM users WHERE id = ?").get(userId) as
    | Record<string, unknown>
    | undefined;

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE users SET password_hash = ?, password_salt = ? WHERE id = ?").run(
      hash,
      salt,
      userId
    );
    db.prepare("UPDATE password_resets SET used_at = ? WHERE token_hash = ?").run(
      new Date().toISOString(),
      String(row.token_hash)
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
