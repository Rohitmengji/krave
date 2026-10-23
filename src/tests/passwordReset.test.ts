import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailMessage } from "@/lib/server/mailer";

// The route sends mail from `after()`, which needs a live Next request. Here the callbacks
// are collected and run on demand, and mail is captured instead of sent.
const afterTasks = vi.hoisted(() => [] as Array<() => unknown>);
const sent = vi.hoisted(() => [] as MailMessage[]);
const mailFailure = vi.hoisted(() => ({ current: null as Error | null }));

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
      if (mailFailure.current) throw mailFailure.current;
      sent.push(message);
    },
  };
});

import { NextRequest } from "next/server";
import { POST } from "@/app/api/webroutes/[...slug]/route";
import { one, run } from "@/lib/server/pg";
import {
  LOGIN_WINDOW_MINUTES,
  MAX_RESET_EMAILS_PER_ADDRESS,
  MAX_RESET_REQUESTS_PER_CLIENT,
  registerUser,
  verifyCredentials,
} from "@/lib/server/auth";
import { passwordResetMessage, publicOrigin } from "@/lib/server/passwordResetMail";
import {
  FORGOT_START,
  forgotReducer,
  newPasswordProblem,
  readResetDelivery,
  readResetToken,
  RESET_START,
  resetLink,
  resetReducer,
} from "@/lib/passwordReset";
import {
  hasTestDatabase,
  resetTestDatabase,
  startTestDatabase,
  stopTestDatabase,
} from "./support/testDb";

const TOKEN = "Abc_DEF-123456789012345678901234567890xyz";

describe("reset link format", () => {
  it("carries the token in the fragment, which never reaches a server or a Referer", () => {
    const link = resetLink("https://krave.example", TOKEN);
    expect(link).toBe(`https://krave.example/reset-password#token=${TOKEN}`);
    expect(new URL(link).search).toBe("");
  });

  it.each([
    [`#token=${TOKEN}`, TOKEN],
    [`token=${TOKEN}`, TOKEN],
    [`#other=1&token=${TOKEN}`, TOKEN],
    ["", null],
    ["#", null],
    ["#token=", null],
    ["#token=short", null],
    [`#token=${TOKEN}!`, null],
    [`#token=${TOKEN.replace("_", " ")}`, null],
    [`#token=${"a".repeat(201)}`, null],
  ])("reads %j as %j", (hash, expected) => {
    expect(readResetToken(hash)).toBe(expected);
  });
});

describe("new password rules", () => {
  it.each([
    ["", "", /at least 10/],
    ["a".repeat(9), "a".repeat(9), /at least 10/],
    ["a".repeat(10), "a".repeat(10), null],
    ["a".repeat(200), "a".repeat(200), null],
    ["a".repeat(201), "a".repeat(201), /200 characters or fewer/],
    ["a".repeat(10), "a".repeat(10) + " ", /don't match/],
    ["correct horse", "Correct horse", /don't match/],
  ])("%#: checks length before the match", (password, confirmation, expected) => {
    const problem = newPasswordProblem(password, confirmation);
    if (expected === null) expect(problem).toBeNull();
    else expect(problem).toMatch(expected);
  });
});

describe("forgot-password screen state", () => {
  it("ignores a second send while one is in flight, and only a sending request can land", () => {
    const sending = forgotReducer(FORGOT_START, { type: "SEND" });
    expect(forgotReducer(sending, { type: "SEND" })).toBe(sending);
    expect(forgotReducer(FORGOT_START, { type: "SENT", email: "a@b.co", delivery: "email" })).toBe(
      FORGOT_START
    );

    const sent = forgotReducer(sending, { type: "SENT", email: "a@b.co", delivery: "email" });
    expect(sent).toEqual({ status: "sent", email: "a@b.co", delivery: "email" });
    expect(forgotReducer(sent, { type: "EDIT" })).toEqual(FORGOT_START);
  });

  it("returns to the form with the reason when sending fails", () => {
    const sending = forgotReducer(FORGOT_START, { type: "SEND" });
    expect(forgotReducer(sending, { type: "FAILED", message: "Too many" })).toEqual({
      status: "editing",
      error: "Too many",
    });
    expect(forgotReducer(sending, { type: "EDIT" })).toBe(sending);
  });

  it("only believes the server about a server-log delivery", () => {
    expect(readResetDelivery({ delivery: "server-log" })).toBe("server-log");
    expect(readResetDelivery({ delivery: "email" })).toBe("email");
    expect(readResetDelivery({ delivery: 1 })).toBe("email");
    expect(readResetDelivery(null)).toBe("email");
  });
});

describe("reset screen state", () => {
  it("saves once, and only a save in flight can find the link dead", () => {
    const saving = resetReducer(RESET_START, { type: "SAVE" });
    expect(saving).toEqual({ status: "saving" });
    expect(resetReducer(saving, { type: "SAVE" })).toBe(saving);
    expect(resetReducer(RESET_START, { type: "LINK_DEAD", message: "gone" })).toBe(RESET_START);

    const dead = resetReducer(saving, { type: "LINK_DEAD", message: "gone" });
    expect(dead).toEqual({ status: "link-dead", message: "gone" });
    // A late refusal must not reopen a form for a link that no longer works.
    expect(resetReducer(dead, { type: "REFUSED", message: "late" })).toBe(dead);
  });

  it("keeps the form, with the reason, for anything the person can fix", () => {
    const saving = resetReducer(RESET_START, { type: "SAVE" });
    expect(resetReducer(saving, { type: "REFUSED", message: "Too short" })).toEqual({
      status: "editing",
      error: "Too short",
    });
  });
});

describe("public origin for emailed links", () => {
  const request = "http://localhost:3005";

  it("prefers the configured address and drops any path from it", () => {
    expect(publicOrigin(request, { KRAVE_PUBLIC_URL: "https://krave.example/app/" })).toBe(
      "https://krave.example"
    );
    expect(publicOrigin(request, { VERCEL_PROJECT_PRODUCTION_URL: "krave-neon.vercel.app" })).toBe(
      "https://krave-neon.vercel.app"
    );
  });

  it("never trusts the request's own host in production", () => {
    expect(publicOrigin("https://evil.example", { NODE_ENV: "production" })).toBeNull();
    expect(publicOrigin(request, { NODE_ENV: "development" })).toBe(request);
  });

  it("refuses an address that is not http(s) rather than mailing a broken link", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(publicOrigin(request, { KRAVE_PUBLIC_URL: "javascript:alert(1)" })).toBeNull();
    expect(publicOrigin(request, { KRAVE_PUBLIC_URL: "not a url" })).toBeNull();
    expect(logged).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });
});

describe("reset email", () => {
  it("escapes the link in HTML and keeps the token out of the subject", () => {
    const message = passwordResetMessage("a@b.co", `https://x.example/reset-password#token=${TOKEN}"<b>`);
    expect(message.html).not.toContain('"<b>');
    expect(message.html).toContain("&#34;&#60;b&#62;");
    expect(message.text).toContain(`#token=${TOKEN}`);
    expect(message.subject).not.toContain(TOKEN);
  });
});

const ACCOUNT = { email: "forgot@krave.test", password: "original-password" };
const SITE = "https://krave.example";
const SMTP_ENV = {
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: "sender@krave.test",
  SMTP_PASS: "app-password",
};

function post(path: string, body: unknown, headers: Record<string, string> = {}, origin = "http://localhost") {
  const request = new NextRequest(`${origin}/api/webroutes/${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", ...headers },
  });
  return POST(request, { params: Promise.resolve({ slug: path.split("/") }) });
}

async function runAfterTasks(): Promise<void> {
  for (const task of afterTasks.splice(0)) await task();
}

async function count(table: string): Promise<number> {
  return Number((await one<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`))?.n);
}

async function seedAttempts(key: string, n: number): Promise<void> {
  await run(
    `INSERT INTO login_attempts (attempt_key, attempted_at, succeeded)
     SELECT $1, $2, 0 FROM generate_series(1, $3)`,
    [key, new Date(Date.now() - 60_000).toISOString(), n]
  );
}

function tokenIn(message: MailMessage | undefined): string {
  const token = message?.text.match(/#token=([A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error("No reset link in the email.");
  return token;
}

function stubProductionMail(extra: Record<string, string> = {}) {
  vi.stubEnv("NODE_ENV", "production");
  const env = { ...SMTP_ENV, KRAVE_PUBLIC_URL: SITE, VERCEL_PROJECT_PRODUCTION_URL: "", ...extra };
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
}

describe.skipIf(!hasTestDatabase)("password reset by email (Postgres)", () => {
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
    mailFailure.current = null;
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("emails a working reset link in production once SMTP is configured", async () => {
    await registerUser(ACCOUNT);
    stubProductionMail();

    const forgot = await post("auth/forgot", { email: ACCOUNT.email });
    expect(forgot.status).toBe(200);
    expect(await forgot.json()).toMatchObject({ status: "success", delivery: "email" });

    await runAfterTasks();
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(ACCOUNT.email);
    expect(sent[0].text).toContain(`${SITE}/reset-password#token=`);

    const reset = await post("auth/reset", { token: tokenIn(sent[0]), password: "brand-new-password" });
    expect(reset.status).toBe(200);
    await expect(
      verifyCredentials({ email: ACCOUNT.email, password: "brand-new-password" })
    ).resolves.toMatchObject({ email: ACCOUNT.email });

    // The owner hears about it, so a reset they did not make is not silent.
    await runAfterTasks();
    expect(sent.map((message) => message.subject)).toEqual([
      "Reset your KRAVE password",
      "Your KRAVE password was changed",
    ]);
    expect(sent[1].text).toContain(`${SITE}/signin`);
  });

  it("answers known and unknown addresses identically and mails only the account", async () => {
    await registerUser(ACCOUNT);
    stubProductionMail();

    const known = await post("auth/forgot", { email: ACCOUNT.email });
    const unknown = await post("auth/forgot", { email: "ghost@krave.test" });

    expect(known.status).toBe(unknown.status);
    expect(await known.json()).toEqual(await unknown.json());
    // Nothing is looked up or written until after the response.
    expect(await count("password_resets")).toBe(0);

    await runAfterTasks();
    expect(sent.map((message) => message.to)).toEqual([ACCOUNT.email]);
    expect(await count("password_resets")).toBe(1);
  });

  it("links to the configured site even when the request names another host", async () => {
    await registerUser(ACCOUNT);
    stubProductionMail();

    await post("auth/forgot", { email: ACCOUNT.email }, { host: "evil.example" }, "https://evil.example");
    await runAfterTasks();

    expect(sent[0].text).toContain(`${SITE}/reset-password#token=`);
    expect(sent[0].text).not.toContain("evil.example");
  });

  it("creates no token in production when it cannot say which site to link to", async () => {
    await registerUser(ACCOUNT);
    stubProductionMail({ KRAVE_PUBLIC_URL: "" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post("auth/forgot", { email: ACCOUNT.email });

    expect(response.status).toBe(503);
    expect(afterTasks).toHaveLength(0);
    expect(await count("password_resets")).toBe(0);
    expect(String(logged.mock.calls[0]?.[0])).toMatch(/KRAVE_PUBLIC_URL/);
  });

  it("answers a half-configured mail server with a generic error and logs why", async () => {
    stubProductionMail({ SMTP_PASS: "" });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post("auth/forgot", { email: ACCOUNT.email });

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toMatch(/SMTP/);
    expect(String(logged.mock.calls[0]?.[1])).toMatch(/SMTP_USER and SMTP_PASS/);
  });

  it("rejects a malformed address without counting it against anyone", async () => {
    stubProductionMail();

    const response = await post("auth/forgot", { email: "not-an-email" });

    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(/valid email/i);
    expect(await count("login_attempts")).toBe(0);
  });

  it("limits requests per address the same way whether or not the account exists", async () => {
    await registerUser(ACCOUNT);
    stubProductionMail();

    for (const email of [ACCOUNT.email, "ghost@krave.test"]) {
      for (let attempt = 0; attempt < MAX_RESET_EMAILS_PER_ADDRESS; attempt += 1) {
        expect((await post("auth/forgot", { email }, { "x-forwarded-for": `198.51.100.${attempt}` })).status).toBe(200);
      }
      const refused = await post("auth/forgot", { email }, { "x-forwarded-for": "198.51.100.99" });
      expect(refused.status).toBe(429);
      expect((await refused.json()).message).toBe(
        `Too many reset requests. Try again in ${LOGIN_WINDOW_MINUTES} minutes.`
      );
    }

    // Another address is unaffected.
    expect((await post("auth/forgot", { email: "other@krave.test" })).status).toBe(200);
    await runAfterTasks();
    expect(sent).toHaveLength(MAX_RESET_EMAILS_PER_ADDRESS);
  });

  it("limits one client spraying many addresses", async () => {
    stubProductionMail();
    await seedAttempts("reset-client:203.0.113.5", MAX_RESET_REQUESTS_PER_CLIENT);

    const from = (ip: string) => post("auth/forgot", { email: "anyone@krave.test" }, { "x-forwarded-for": ip });
    expect((await from("203.0.113.5")).status).toBe(429);
    expect((await from("203.0.113.6")).status).toBe(200);
  });

  it("logs a failed send for the operator without changing what the customer saw", async () => {
    await registerUser(ACCOUNT);
    stubProductionMail();
    mailFailure.current = new Error("535 authentication failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await post("auth/forgot", { email: ACCOUNT.email });
    expect(response.status).toBe(200);

    await runAfterTasks();
    expect(String(logged.mock.calls[0]?.[0])).toMatch(/password reset/i);
  });

  it("writes the link to the server log in development when there is no mail server", async () => {
    await registerUser(ACCOUNT);
    vi.stubEnv("NODE_ENV", "development");
    const logged = vi.spyOn(console, "info").mockImplementation(() => {});

    const response = await post("auth/forgot", { email: ACCOUNT.email }, {}, "http://localhost:3005");
    expect(await response.json()).toMatchObject({ status: "success", delivery: "server-log" });

    await runAfterTasks();
    expect(sent).toHaveLength(0);
    expect(String(logged.mock.calls[0]?.[0])).toContain("http://localhost:3005/reset-password#token=");
  });

  it("answers 410 for a used or invalid link, so the screen offers a new one", async () => {
    await registerUser(ACCOUNT);
    stubProductionMail();
    await post("auth/forgot", { email: ACCOUNT.email });
    await runAfterTasks();
    const token = tokenIn(sent[0]);

    expect((await post("auth/reset", { token, password: "first-new-password" })).status).toBe(200);
    const reused = await post("auth/reset", { token, password: "second-new-password" });
    expect(reused.status).toBe(410);
    expect((await reused.json()).message).toMatch(/expired or was already used/);

    expect((await post("auth/reset", { token: "x", password: "second-new-password" })).status).toBe(410);
    // A fixable problem stays a 400 and leaves a valid link usable.
    await post("auth/forgot", { email: ACCOUNT.email });
    await runAfterTasks();
    const fresh = tokenIn(sent.at(-1));
    expect((await post("auth/reset", { token: fresh, password: "short" })).status).toBe(400);
    expect((await post("auth/reset", { token: fresh, password: "third-new-password" })).status).toBe(200);
  });
});
