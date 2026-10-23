import { randomBytes } from "node:crypto";
import { one, transaction } from "./pg";
import {
  databaseErrorCode,
  hashToken,
  LOGIN_WINDOW_MINUTES,
  normalizeEmail,
  reserveClientQuota,
  rowToUser,
  verifyAccountPassword,
  type AccountUser,
} from "./auth";
import {
  displayNameProblem,
  EMAIL_CHANGE_LINK_MINUTES,
  normalizePhone,
  VERIFY_LINK_HOURS,
} from "@/lib/accountRules";

export const EMAIL_LINK_SPENT = "This link has expired or was already used.";
export const EMAIL_LINK_STALE =
  "This link was for an email address that is no longer on the account.";
export const EMAIL_TAKEN = "That email address already belongs to another account.";
export const ALREADY_YOUR_EMAIL = "That is already your email address.";
/** Verification and change emails together, per account per window. */
export const MAX_ACCOUNT_EMAILS_PER_USER = 5;
export const ACCOUNT_EMAILS_THROTTLED = `Too many emails sent. Try again in ${LOGIN_WINDOW_MINUTES} minutes.`;

export type EmailPurpose = "verify" | "change";

export async function updateProfile(userId: string, input: unknown): Promise<AccountUser> {
  const body = (input ?? {}) as Record<string, unknown>;
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const nameProblem = displayNameProblem(displayName);
  if (nameProblem) throw new Error(nameProblem);
  if (body.phone !== undefined && body.phone !== null && typeof body.phone !== "string") {
    throw new Error("Enter your phone number as text.");
  }
  const phone = normalizePhone(typeof body.phone === "string" ? body.phone : "");
  if (!phone.ok) throw new Error(phone.message);

  const row = await one<Record<string, unknown>>(
    "UPDATE users SET display_name = $2, phone = $3 WHERE id = $1 RETURNING *",
    [userId, displayName, phone.phone]
  );
  if (!row) throw new Error("This account no longer exists.");
  return rowToUser(row);
}

/** Issues a link for this purpose; any earlier unused one for it stops working. */
async function issueEmailToken(
  userId: string,
  purpose: EmailPurpose,
  email: string
): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const lifetime =
    purpose === "verify" ? VERIFY_LINK_HOURS * 3_600_000 : EMAIL_CHANGE_LINK_MINUTES * 60_000;
  await transaction(async (client) => {
    // Without the lock, two requests at once each delete before either inserts and both
    // links stay live. Taken alone, so the DELETE reads after the other committed.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `email-token:${purpose}:${userId}`,
    ]);
    await client.query(
      "DELETE FROM email_tokens WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL",
      [userId, purpose]
    );
    await client.query(
      `INSERT INTO email_tokens (token_hash, user_id, purpose, email, created_at, expires_at, used_at)
       VALUES ($1, $2, $3, $4, $5, $6, NULL)`,
      [
        hashToken(token),
        userId,
        purpose,
        email,
        now.toISOString(),
        new Date(now.getTime() + lifetime).toISOString(),
      ]
    );
  });
  return token;
}

/** For the welcome email at sign-up, which the sign-up limit already bounds. */
export function createVerificationToken(user: AccountUser): Promise<string> {
  return issueEmailToken(user.id, "verify", user.email);
}

/** A fresh verification link, or null when the address is already confirmed. */
export async function requestVerification(user: AccountUser): Promise<string | null> {
  if (user.emailVerified) return null;
  await reserveClientQuota(
    `account-email:${user.id}`,
    MAX_ACCOUNT_EMAILS_PER_USER,
    ACCOUNT_EMAILS_THROTTLED
  );
  return issueEmailToken(user.id, "verify", user.email);
}

/**
 * Starts moving the account to a new address. Nothing changes until the link sent there is
 * opened, so a typo cannot lock the owner out.
 */
export async function requestEmailChange(
  user: AccountUser,
  input: unknown,
  clientKey: string
): Promise<{ email: string; token: string }> {
  const body = (input ?? {}) as Record<string, unknown>;
  const email = normalizeEmail(body.newEmail);
  if (email === user.email) throw new Error(ALREADY_YOUR_EMAIL);
  await verifyAccountPassword(user.id, body.password, clientKey);
  await reserveClientQuota(
    `account-email:${user.id}`,
    MAX_ACCOUNT_EMAILS_PER_USER,
    ACCOUNT_EMAILS_THROTTLED
  );
  return { email, token: await issueEmailToken(user.id, "change", email) };
}

export interface ConfirmedEmail {
  purpose: EmailPurpose;
  email: string;
  previousEmail: string;
}

/** Opens a verification or change link. Needs no session: the link is the proof. */
export async function confirmEmailToken(token: unknown): Promise<ConfirmedEmail> {
  if (typeof token !== "string" || token.length < 20 || token.length > 200) {
    throw new Error(EMAIL_LINK_SPENT);
  }
  try {
    return await transaction(async (client) => {
      const now = new Date().toISOString();
      const claimed = (
        await client.query(
          `UPDATE email_tokens SET used_at = $1
           WHERE token_hash = $2 AND used_at IS NULL AND expires_at > $1
           RETURNING user_id, purpose, email`,
          [now, hashToken(token)]
        )
      ).rows[0] as Record<string, unknown> | undefined;
      if (!claimed) throw new Error(EMAIL_LINK_SPENT);

      const userId = String(claimed.user_id);
      const purpose: EmailPurpose = claimed.purpose === "change" ? "change" : "verify";
      const email = String(claimed.email);
      const owner = (
        await client.query("SELECT email FROM users WHERE id = $1 FOR UPDATE", [userId])
      ).rows[0] as Record<string, unknown> | undefined;
      if (!owner) throw new Error(EMAIL_LINK_SPENT);
      const previousEmail = String(owner.email);

      if (purpose === "verify") {
        if (previousEmail !== email) throw new Error(EMAIL_LINK_STALE);
        await client.query(
          "UPDATE users SET email_verified_at = COALESCE(email_verified_at, $2) WHERE id = $1",
          [userId, now]
        );
      } else {
        await client.query("UPDATE users SET email = $2, email_verified_at = $3 WHERE id = $1", [
          userId,
          email,
          now,
        ]);
        // Every other outstanding link went to the old address.
        await client.query("DELETE FROM email_tokens WHERE user_id = $1 AND used_at IS NULL", [
          userId,
        ]);
        await client.query(
          "DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL",
          [userId]
        );
      }
      return { purpose, email, previousEmail };
    });
  } catch (error) {
    // Someone registered the new address after the link was sent.
    if (databaseErrorCode(error) === "23505") throw new Error(EMAIL_TAKEN, { cause: error });
    throw error;
  }
}
