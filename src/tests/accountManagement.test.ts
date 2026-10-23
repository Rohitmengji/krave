import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailMessage } from "@/lib/server/mailer";

// Mail is sent from `after()`, which needs a live Next request. Here the callbacks are
// collected and run on demand, and mail is captured instead of sent.
const afterTasks = vi.hoisted(() => [] as Array<() => unknown>);
const sent = vi.hoisted(() => [] as MailMessage[]);

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (task: () => unknown) => {
      afterTasks.push(task);
    },
  };
});

vi.mock("@/lib/server/mailer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/mailer")>();
  return {
    ...actual,
    sendMail: async (message: MailMessage) => {
      sent.push(message);
    },
  };
});

import { NextRequest } from "next/server";
import { POST } from "@/app/api/webroutes/[...slug]/route";
import { one, run } from "@/lib/server/pg";
import {
  createPasswordReset,
  createSession,
  DELETE_BLOCKED_BY_RESTAURANT,
  DELETE_BLOCKED_BY_STAFF_ACCESS,
  getUserForToken,
  MAX_LOGIN_ATTEMPTS,
  REAUTH_THROTTLED,
  registerUser,
  resetPassword,
  SESSION_COOKIE,
  verifyCredentials,
  WRONG_CURRENT_PASSWORD,
} from "@/lib/server/auth";
import { MAX_ACCOUNT_EMAILS_PER_USER } from "@/lib/server/accountService";
import { grantOutletStaff } from "@/lib/server/staff";
import { listBookmarks, setBookmarks } from "@/lib/server/accountStore";
import { RESTAURANTS_DATA } from "@/data/zomatoReconstructedData";
import {
  hasTestDatabase,
  resetTestDatabase,
  startTestDatabase,
  stopTestDatabase,
} from "./support/testDb";

const SITE = "https://krave.example";
const OWNER = { email: "owner@krave.test", password: "original-password" };

function stubProductionMail() {
  vi.stubEnv("NODE_ENV", "production");
  const env = {
    SMTP_HOST: "smtp.example.test",
    SMTP_USER: "sender@krave.test",
    SMTP_PASS: "app-password",
    KRAVE_PUBLIC_URL: SITE,
    VERCEL_PROJECT_PRODUCTION_URL: "",
  };
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
}

function post(path: string, body: unknown, sessionToken?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionToken) headers.cookie = `${SESSION_COOKIE}=${sessionToken}`;
  const request = new NextRequest(`http://localhost/api/webroutes/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
  return POST(request, { params: Promise.resolve({ slug: path.split("/") }) });
}

async function runAfterTasks(): Promise<void> {
  for (const task of afterTasks.splice(0)) await task();
}

async function signedIn() {
  const user = await registerUser(OWNER);
  const { token } = await createSession(user.id);
  return { user, token };
}

function linkToken(message: MailMessage | undefined): string {
  const token = message?.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error("No link in the email.");
  return token;
}

async function userExists(id: string): Promise<boolean> {
  return (await one("SELECT 1 FROM users WHERE id = $1", [id])) !== undefined;
}

describe.skipIf(!hasTestDatabase)("account management (Postgres)", () => {
  beforeAll(async () => {
    await startTestDatabase();
  });

  afterAll(async () => {
    await stopTestDatabase();
  });

  beforeEach(async () => {
    await resetTestDatabase();
    afterTasks.length = 0;
    sent.length = 0;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    "account/profile",
    "account/password",
    "account/email",
    "account/verify-email/resend",
    "account/delete",
  ])("refuses %s without a session", async (path) => {
    expect((await post(path, {})).status).toBe(401);
  });

  describe("profile", () => {
    it("saves a name and a normalised phone, for this account only", async () => {
      const { user, token } = await signedIn();
      const other = await registerUser({ email: "other@krave.test", password: "other-password" });

      const response = await post(
        "account/profile",
        { displayName: "  Rohit Mengji ", phone: "98765 43210" },
        token
      );
      expect(response.status).toBe(200);
      expect((await response.json()).user).toMatchObject({
        id: user.id,
        displayName: "Rohit Mengji",
        phone: "+919876543210",
      });
      expect(await getUserForToken(token)).toMatchObject({ phone: "+919876543210" });
      expect(await one("SELECT display_name, phone FROM users WHERE id = $1", [other.id])).toEqual({
        display_name: "other",
        phone: null,
      });

      // An empty number removes it.
      await post("account/profile", { displayName: "Rohit Mengji", phone: "" }, token);
      expect((await getUserForToken(token))?.phone).toBeNull();
    });

    it.each([
      [{ displayName: "Rohit", phone: "12345" }, /10-digit/],
      [{ displayName: "R", phone: "" }, /at least 2/],
      [{ displayName: "Rohit\nAdmin", phone: "" }, /line breaks/],
      [{ displayName: "Rohit", phone: 9876543210 }, /as text/],
    ])("refuses %j and changes nothing", async (body, message) => {
      const { token } = await signedIn();
      const response = await post("account/profile", body, token);
      expect(response.status).toBe(400);
      expect((await response.json()).message).toMatch(message);
      expect(await getUserForToken(token)).toMatchObject({ displayName: "owner", phone: null });
    });
  });

  describe("password", () => {
    it("changes it, keeps this device signed in, and signs the others out", async () => {
      stubProductionMail();
      const { user, token } = await signedIn();
      const { token: otherDevice } = await createSession(user.id);
      const earlierReset = await createPasswordReset({ email: OWNER.email });

      const response = await post(
        "account/password",
        { currentPassword: OWNER.password, newPassword: "brand-new-password" },
        token
      );
      expect(response.status).toBe(200);

      expect(await getUserForToken(token)).not.toBeNull();
      expect(await getUserForToken(otherDevice)).toBeNull();
      await expect(verifyCredentials(OWNER, "10.9.9.1")).rejects.toThrow(/incorrect/);
      await expect(
        verifyCredentials({ email: OWNER.email, password: "brand-new-password" }, "10.9.9.2")
      ).resolves.toMatchObject({ id: user.id });
      // A reset link sent before the change cannot undo it.
      await expect(resetPassword(earlierReset!.token, "someone-elses-pick")).rejects.toThrow(
        /expired|already used/
      );

      await runAfterTasks();
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ to: OWNER.email, subject: "Your KRAVE password was changed" });
      expect(sent[0].text).toContain("account settings");
    });

    it("refuses a wrong current password, then locks even the right one", async () => {
      const { token } = await signedIn();
      for (let attempt = 0; attempt < MAX_LOGIN_ATTEMPTS; attempt += 1) {
        const response = await post(
          "account/password",
          { currentPassword: `wrong-guess-${attempt}`, newPassword: "brand-new-password" },
          token
        );
        expect(response.status).toBe(400);
        expect((await response.json()).message).toBe(WRONG_CURRENT_PASSWORD);
      }
      const locked = await post(
        "account/password",
        { currentPassword: OWNER.password, newPassword: "brand-new-password" },
        token
      );
      expect(locked.status).toBe(429);
      expect((await locked.json()).message).toBe(REAUTH_THROTTLED);
      await expect(verifyCredentials(OWNER, "10.9.9.3")).resolves.toBeTruthy();
    }, 120_000);

    it("refuses a repeat or too-short password without spending an attempt", async () => {
      const { user, token } = await signedIn();
      for (const newPassword of [OWNER.password, "short"]) {
        const response = await post(
          "account/password",
          { currentPassword: OWNER.password, newPassword },
          token
        );
        expect(response.status).toBe(400);
      }
      const attempts = await one<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM login_attempts WHERE attempt_key = $1",
        [`reauth:${user.id}`]
      );
      expect(attempts?.n).toBe(0);
    });

    it("lets exactly one of two simultaneous changes win", async () => {
      const { token } = await signedIn();
      const responses = await Promise.all(
        ["first-new-password", "second-new-password"].map((newPassword) =>
          post("account/password", { currentPassword: OWNER.password, newPassword }, token)
        )
      );
      const statuses = responses.map((response) => response.status);
      expect(statuses.filter((status) => status === 200)).toHaveLength(1);
      // The loser either saw the change land (409) or checked against the new password (400).
      expect(statuses.filter((status) => status === 409 || status === 400)).toHaveLength(1);
      const winner = statuses[0] === 200 ? "first-new-password" : "second-new-password";
      await expect(
        verifyCredentials({ email: OWNER.email, password: winner }, "10.9.9.4")
      ).resolves.toBeTruthy();
    });
  });

  describe("email address", () => {
    it("moves the account only once the link sent to the new address is opened", async () => {
      stubProductionMail();
      const { user, token } = await signedIn();

      const response = await post(
        "account/email",
        { newEmail: "New@Krave.test", password: OWNER.password },
        token
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ pendingEmail: "new@krave.test", delivery: "email" });
      expect((await getUserForToken(token))?.email).toBe(OWNER.email);

      await runAfterTasks();
      expect(sent.map((message) => message.to)).toEqual(["new@krave.test"]);
      expect(sent[0].text).toContain(`${SITE}/verify-email#token=`);
      expect(sent[0].subject).not.toContain(linkToken(sent[0]));

      const confirmed = await post("auth/verify-email", { token: linkToken(sent[0]) });
      expect(confirmed.status).toBe(200);
      expect(await confirmed.json()).toMatchObject({ purpose: "change", email: "new@krave.test" });
      expect(await getUserForToken(token)).toMatchObject({
        email: "new@krave.test",
        emailVerified: true,
      });
      await expect(
        verifyCredentials({ email: "new@krave.test", password: OWNER.password }, "10.9.8.1")
      ).resolves.toMatchObject({ id: user.id });

      // The old address hears about it.
      await runAfterTasks();
      expect(sent.at(-1)).toMatchObject({
        to: OWNER.email,
        subject: "Your KRAVE email address was changed",
      });
      expect(sent.at(-1)?.text).toContain("new@krave.test");

      expect((await post("auth/verify-email", { token: linkToken(sent[0]) })).status).toBe(410);
    });

    it("checks the password and the address before sending anything", async () => {
      stubProductionMail();
      const { token } = await signedIn();
      const wrong = await post(
        "account/email",
        { newEmail: "new@krave.test", password: "not-my-password" },
        token
      );
      expect(wrong.status).toBe(400);
      const same = await post(
        "account/email",
        { newEmail: OWNER.email.toUpperCase(), password: OWNER.password },
        token
      );
      expect((await same.json()).message).toMatch(/already your email/);
      const malformed = await post(
        "account/email",
        { newEmail: "not-an-address", password: OWNER.password },
        token
      );
      expect(malformed.status).toBe(400);

      await runAfterTasks();
      expect(sent).toHaveLength(0);
      expect(await one("SELECT 1 FROM email_tokens")).toBeUndefined();
    });

    it("refuses an address someone registered after the link went out", async () => {
      stubProductionMail();
      const { token } = await signedIn();
      await post("account/email", { newEmail: "taken@krave.test", password: OWNER.password }, token);
      await runAfterTasks();
      await registerUser({ email: "taken@krave.test", password: "someone-elses-pw" });

      const confirmed = await post("auth/verify-email", { token: linkToken(sent[0]) });
      expect(confirmed.status).toBe(409);
      expect((await confirmed.json()).message).toMatch(/already belongs to another account/);
      expect((await getUserForToken(token))?.email).toBe(OWNER.email);
    });

    it("keeps only the newest change link working", async () => {
      stubProductionMail();
      const { token } = await signedIn();
      await post("account/email", { newEmail: "first@krave.test", password: OWNER.password }, token);
      await post("account/email", { newEmail: "second@krave.test", password: OWNER.password }, token);
      await runAfterTasks();
      const [first, second] = sent;

      expect((await post("auth/verify-email", { token: linkToken(first) })).status).toBe(410);
      expect((await post("auth/verify-email", { token: linkToken(second) })).status).toBe(200);
      expect((await getUserForToken(token))?.email).toBe("second@krave.test");
    });

    it("answers 410 for a link that was never issued", async () => {
      for (const token of ["x", "a".repeat(43), 42]) {
        expect((await post("auth/verify-email", { token })).status).toBe(410);
      }
    });
  });

  describe("email confirmation", () => {
    it("emails a new account its confirmation link at sign-up", async () => {
      stubProductionMail();
      const response = await post("auth/register", {
        email: "fresh@krave.test",
        password: "fresh-password-1",
      });
      expect(response.status).toBe(201);
      expect((await response.json()).user).toMatchObject({
        email: "fresh@krave.test",
        emailVerified: false,
        phone: null,
      });

      await runAfterTasks();
      expect(sent).toEqual([
        expect.objectContaining({ to: "fresh@krave.test", subject: "Confirm your KRAVE email address" }),
      ]);
      const confirmed = await post("auth/verify-email", { token: linkToken(sent[0]) });
      expect(await confirmed.json()).toMatchObject({ purpose: "verify", email: "fresh@krave.test" });
      const row = await one<{ email_verified_at: unknown }>(
        "SELECT email_verified_at FROM users WHERE email = $1",
        ["fresh@krave.test"]
      );
      expect(row?.email_verified_at).toEqual(expect.any(String));
    });

    it("starts new accounts unconfirmed; only accounts older than the column count as confirmed", async () => {
      const column = await one<{ column_default: unknown }>(
        `SELECT column_default FROM information_schema.columns
         WHERE table_name = 'users' AND column_name = 'email_verified_at'`
      );
      expect(column?.column_default ?? null).toBeNull();
      expect((await registerUser({ email: "plain@krave.test", password: "plain-password-1" })).emailVerified).toBe(
        false
      );
    });

    it("resends within a limit, keeps only the newest link, and stops once confirmed", async () => {
      stubProductionMail();
      const { token } = await signedIn();
      for (let send = 0; send < MAX_ACCOUNT_EMAILS_PER_USER; send += 1) {
        expect((await post("account/verify-email/resend", {}, token)).status).toBe(200);
      }
      expect((await post("account/verify-email/resend", {}, token)).status).toBe(429);

      await runAfterTasks();
      expect(sent).toHaveLength(MAX_ACCOUNT_EMAILS_PER_USER);
      expect((await post("auth/verify-email", { token: linkToken(sent[0]) })).status).toBe(410);
      expect((await post("auth/verify-email", { token: linkToken(sent.at(-1)) })).status).toBe(200);
      expect((await post("account/verify-email/resend", {}, token)).status).toBe(409);
    });

    it("does not confirm an address the account no longer uses", async () => {
      stubProductionMail();
      const { user, token } = await signedIn();
      await post("account/verify-email/resend", {}, token);
      await runAfterTasks();
      await run("UPDATE users SET email = $2 WHERE id = $1", [user.id, "moved@krave.test"]);

      expect((await post("auth/verify-email", { token: linkToken(sent[0]) })).status).toBe(410);
      expect((await getUserForToken(token))?.emailVerified).toBe(false);
    });
  });

  describe("deleting the account", () => {
    it("removes it with what it owns, signs it out, and frees the address", async () => {
      stubProductionMail();
      const { user, token } = await signedIn();
      await setBookmarks(user.id, [RESTAURANTS_DATA[0].resId]);

      const response = await post(
        "account/delete",
        { password: OWNER.password, confirmation: "DELETE" },
        token
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("set-cookie")).toContain(`${SESSION_COOKIE}=;`);
      expect(await userExists(user.id)).toBe(false);
      expect(await getUserForToken(token)).toBeNull();
      expect(await listBookmarks(user.id)).toEqual([]);

      await runAfterTasks();
      expect(sent).toEqual([
        expect.objectContaining({ to: OWNER.email, subject: "Your KRAVE account was deleted" }),
      ]);
      await expect(registerUser(OWNER)).resolves.toMatchObject({ email: OWNER.email });
    });

    it.each([
      [{ password: OWNER.password, confirmation: "delete" }, /Type DELETE/],
      [{ password: OWNER.password }, /Type DELETE/],
      [{ password: "wrong-password", confirmation: "DELETE" }, /current password is incorrect/],
    ])("needs the typed word and the password: %j", async (body, message) => {
      const { user, token } = await signedIn();
      const response = await post("account/delete", body, token);
      expect(response.status).toBe(400);
      expect((await response.json()).message).toMatch(message);
      expect(await userExists(user.id)).toBe(true);
    });

    it("refuses an account with staff access, granted or configured", async () => {
      const { user, token } = await signedIn();
      const body = { password: OWNER.password, confirmation: "DELETE" };

      vi.stubEnv("KRAVE_STAFF_EMAILS", OWNER.email);
      const configured = await post("account/delete", body, token);
      expect(configured.status).toBe(409);
      expect((await configured.json()).message).toBe(DELETE_BLOCKED_BY_STAFF_ACCESS);
      vi.unstubAllEnvs();

      await grantOutletStaff(user.id, user.id, 1);
      expect((await post("account/delete", body, token)).status).toBe(409);
      expect(await userExists(user.id)).toBe(true);
    });

    it("refuses while it owns something that must keep its owner", async () => {
      const { user, token } = await signedIn();
      await run(
        "CREATE TABLE IF NOT EXISTS account_delete_probe (owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT)"
      );
      try {
        await run("INSERT INTO account_delete_probe (owner_id) VALUES ($1)", [user.id]);
        const response = await post(
          "account/delete",
          { password: OWNER.password, confirmation: "DELETE" },
          token
        );
        expect(response.status).toBe(409);
        expect((await response.json()).message).toBe(DELETE_BLOCKED_BY_RESTAURANT);
        expect(await getUserForToken(token)).not.toBeNull();
      } finally {
        await run("DROP TABLE IF EXISTS account_delete_probe");
      }
    });
  });
});
