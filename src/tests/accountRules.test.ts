import { describe, expect, it } from "vitest";
import {
  accountPageReducer,
  displayNameProblem,
  emailLink,
  formatPhone,
  normalizePhone,
  readAccountProfile,
  SECTION_START,
  sectionReducer,
  VERIFY_START,
  verifyReducer,
  type AccountProfile,
} from "@/lib/accountRules";

const USER: AccountProfile = {
  id: "usr_1",
  email: "a@b.co",
  displayName: "Rohit",
  phone: null,
  emailVerified: false,
};

describe("phone numbers", () => {
  it.each([
    ["", null],
    ["   ", null],
    ["98765 43210", "+919876543210"],
    ["98765-43210", "+919876543210"],
    ["098765 43210", "+919876543210"],
    ["919876543210", "+919876543210"],
    ["+91 98765 43210", "+919876543210"],
    ["(+91) 98765-43210", "+919876543210"],
    ["(+1) 415 555 2671", "+14155552671"],
    ["+1 (415) 555-2671", "+14155552671"],
    ["+44 20 7946 0958", "+442079460958"],
  ])("stores %j as %j", (typed, stored) => {
    expect(normalizePhone(typed)).toEqual({ ok: true, phone: stored });
  });

  it.each([
    "12345",
    "1234567890",
    "5876543210",
    "98765432101",
    "+",
    "+0123456789",
    "+12345",
    `+${"9".repeat(16)}`,
    "98765 4321O",
    "९८७६५४३२१०",
    "call me",
    "9".repeat(40),
  ])("refuses %j with a reason", (typed) => {
    const result = normalizePhone(typed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(/10-digit mobile/);
  });

  it("formats Indian mobiles for reading and leaves other countries alone", () => {
    expect(formatPhone("+919876543210")).toBe("+91 98765 43210");
    expect(formatPhone("+14155552671")).toBe("+14155552671");
  });
});

describe("display names", () => {
  it.each([
    ["", /at least 2/],
    [" a ", /at least 2/],
    ["ab", null],
    ["  Rohit Mengji  ", null],
    ["क".repeat(60), null],
    ["a".repeat(61), /60 characters or fewer/],
    ["Rohit\nMengji", /line breaks/],
    ["Rohit\tMengji", /line breaks/],
  ])("%j", (name, expected) => {
    const problem = displayNameProblem(name);
    if (expected === null) expect(problem).toBeNull();
    else expect(problem).toMatch(expected);
  });
});

describe("email links", () => {
  it("carry the token in the fragment", () => {
    const link = emailLink("https://krave.example", "abc_DEF-123");
    expect(link).toBe("https://krave.example/verify-email#token=abc_DEF-123");
    expect(new URL(link).search).toBe("");
  });
});

describe("account form state", () => {
  it("saves once, and only a save in flight can land", () => {
    const saving = sectionReducer(SECTION_START, { type: "SAVE" });
    expect(sectionReducer(saving, { type: "SAVE" })).toBe(saving);
    expect(sectionReducer(SECTION_START, { type: "SAVED", notice: "x" })).toBe(SECTION_START);
    expect(sectionReducer(SECTION_START, { type: "FAILED", message: "x" })).toBe(SECTION_START);
    expect(sectionReducer(saving, { type: "SAVED", notice: "Saved." })).toEqual({
      status: "editing",
      error: null,
      notice: "Saved.",
    });
  });

  it("shows a local refusal only while editing, and typing clears the last outcome", () => {
    const saving = sectionReducer(SECTION_START, { type: "SAVE" });
    expect(sectionReducer(saving, { type: "REFUSED", message: "x" })).toBe(saving);
    const refused = sectionReducer(SECTION_START, { type: "REFUSED", message: "Too short" });
    expect(refused).toEqual({ status: "editing", error: "Too short", notice: null });
    expect(sectionReducer(refused, { type: "EDIT" })).toEqual(SECTION_START);
    // Nothing to clear: the same state, so typing does not re-render the section.
    expect(sectionReducer(SECTION_START, { type: "EDIT" })).toBe(SECTION_START);
  });
});

describe("account page state", () => {
  it("loads once, then ignores a late load", () => {
    const ready = accountPageReducer({ status: "loading" }, { type: "LOADED", user: USER });
    expect(ready).toEqual({ status: "ready", user: USER });
    expect(accountPageReducer(ready, { type: "LOADED", user: null })).toBe(ready);
    expect(accountPageReducer({ status: "loading" }, { type: "LOADED", user: null })).toEqual({
      status: "signed-out",
    });
  });

  it("drops a save that lands after the account ended or for another account", () => {
    const ready = accountPageReducer({ status: "loading" }, { type: "LOADED", user: USER });
    const renamed = { ...USER, displayName: "New" };
    expect(accountPageReducer(ready, { type: "USER_UPDATED", user: renamed })).toEqual({
      status: "ready",
      user: renamed,
    });
    expect(
      accountPageReducer(ready, { type: "USER_UPDATED", user: { ...renamed, id: "usr_other" } })
    ).toBe(ready);
    const ended = accountPageReducer(ready, { type: "ENDED", reason: "deleted" });
    expect(accountPageReducer(ended, { type: "USER_UPDATED", user: renamed })).toBe(ended);
    expect(accountPageReducer({ status: "loading" }, { type: "ENDED", reason: "deleted" })).toEqual({
      status: "loading",
    });
  });
});

describe("email confirmation screen", () => {
  it("confirms once, allows a retry after a dropped connection, but not after a dead link", () => {
    const confirming = verifyReducer(VERIFY_START, { type: "CONFIRM" });
    expect(verifyReducer(confirming, { type: "CONFIRM" })).toBe(confirming);

    const dropped = verifyReducer(confirming, { type: "FAILED", message: "Offline", dead: false });
    expect(verifyReducer(dropped, { type: "CONFIRM" })).toEqual({ status: "confirming" });

    const dead = verifyReducer(confirming, { type: "FAILED", message: "Used", dead: true });
    expect(verifyReducer(dead, { type: "CONFIRM" })).toBe(dead);

    expect(verifyReducer(VERIFY_START, { type: "CONFIRMED", purpose: "verify", email: "x" })).toBe(
      VERIFY_START
    );
  });
});

describe("reading an account from a reply", () => {
  it("needs the identity fields and treats only an explicit true as confirmed", () => {
    expect(readAccountProfile(null)).toBeNull();
    expect(readAccountProfile({ user: null })).toBeNull();
    expect(readAccountProfile({ user: { id: "u", email: "e" } })).toBeNull();
    expect(
      readAccountProfile({ user: { id: "u", email: "e", displayName: "N", emailVerified: "yes" } })
    ).toEqual({ id: "u", email: "e", displayName: "N", phone: null, emailVerified: false });
  });
});
