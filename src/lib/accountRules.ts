/**
 * Account rules and form state, shared by the browser and the server. Nothing here touches
 * the server, so client components may import it.
 */

export const DISPLAY_NAME_MIN_LENGTH = 2;
export const DISPLAY_NAME_MAX_LENGTH = 60;
export const ACCOUNT_PATH = "/account";
export const VERIFY_EMAIL_PATH = "/verify-email";
export const DELETE_CONFIRMATION_WORD = "DELETE";
export const VERIFY_LINK_HOURS = 24;
export const EMAIL_CHANGE_LINK_MINUTES = 60;

/** Same shape as a reset link: the token rides in the fragment, so no server ever logs it. */
export function emailLink(origin: string, token: string): string {
  return `${origin}${VERIFY_EMAIL_PATH}#token=${encodeURIComponent(token)}`;
}

import { pinProblem } from "@/lib/passwordReset";

export function displayNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length < DISPLAY_NAME_MIN_LENGTH) {
    return `Use at least ${DISPLAY_NAME_MIN_LENGTH} characters for your name.`;
  }
  if (trimmed.length > DISPLAY_NAME_MAX_LENGTH) {
    return `Use ${DISPLAY_NAME_MAX_LENGTH} characters or fewer for your name.`;
  }
  // A line break in a name would end up in emails and receipts as a forged extra line.
  if ([...trimmed].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    return "Your name can't contain line breaks or tabs.";
  }
  return null;
}

export type PhoneResult =
  | { readonly ok: true; readonly phone: string | null }
  | { readonly ok: false; readonly message: string };

const PHONE_PROBLEM = "Enter a 10-digit mobile number, or an international number starting with +.";

/**
 * Stores E.164 (+919876543210). Without a +, the number is read as an Indian mobile, with
 * or without a leading 0 or 91. An empty value removes the number.
 */
export function normalizePhone(raw: string): PhoneResult {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: true, phone: null };
  if (trimmed.length > 32 || !/^\(?\+?[\d\s().-]+$/.test(trimmed)) {
    return { ok: false, message: PHONE_PROBLEM };
  }
  const digits = trimmed.replace(/\D/g, "");
  // "+91 …" and "(+91) …" both name the country.
  if (/^\(?\+/.test(trimmed)) {
    return /^[1-9]\d{7,14}$/.test(digits)
      ? { ok: true, phone: `+${digits}` }
      : { ok: false, message: PHONE_PROBLEM };
  }
  const national =
    digits.length === 11 && digits.startsWith("0")
      ? digits.slice(1)
      : digits.length === 12 && digits.startsWith("91")
        ? digits.slice(2)
        : digits;
  return /^[6-9]\d{9}$/.test(national)
    ? { ok: true, phone: `+91${national}` }
    : { ok: false, message: PHONE_PROBLEM };
}

/**
 * What creating an account requires before anything is stored: a name, a mobile number,
 * and a short numeric PIN. Email is checked separately because its error comes from the
 * same normaliser sign-in uses.
 */
export function registrationProblem(input: {
  displayName: string;
  phone: string;
  password: string;
}): string | null {
  const name = displayNameProblem(input.displayName);
  if (name) return name;
  const phone = normalizePhone(input.phone);
  if (!phone.ok) return phone.message;
  if (!phone.phone) return "Enter your mobile number.";
  return pinProblem(input.password);
}

export function formatPhone(phone: string): string {
  const india = /^\+91(\d{5})(\d{5})$/.exec(phone);
  return india ? `+91 ${india[1]} ${india[2]}` : phone;
}

/** One account-page form: editing (with the last outcome) or saving. */
export type SectionState =
  | { readonly status: "editing"; readonly error: string | null; readonly notice: string | null }
  | { readonly status: "saving" };

export type SectionAction =
  | { readonly type: "SAVE" }
  | { readonly type: "SAVED"; readonly notice: string }
  | { readonly type: "FAILED"; readonly message: string }
  /** A problem found before sending anything. */
  | { readonly type: "REFUSED"; readonly message: string }
  | { readonly type: "EDIT" };

export const SECTION_START: SectionState = { status: "editing", error: null, notice: null };

export function sectionReducer(state: SectionState, action: SectionAction): SectionState {
  switch (action.type) {
    case "SAVE":
      return state.status === "saving" ? state : { status: "saving" };
    case "SAVED":
      return state.status === "saving" ? { status: "editing", error: null, notice: action.notice } : state;
    case "FAILED":
      return state.status === "saving" ? { status: "editing", error: action.message, notice: null } : state;
    case "REFUSED":
      return state.status === "editing" ? { status: "editing", error: action.message, notice: null } : state;
    case "EDIT":
      return state.status === "editing" && (state.error !== null || state.notice !== null)
        ? SECTION_START
        : state;
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

/** Fields the account page needs; the full type lives with the account dialog. */
export interface AccountProfile {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly phone: string | null;
  readonly emailVerified: boolean;
}

export type AccountPageState =
  | { readonly status: "loading" }
  | { readonly status: "signed-out" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "ready"; readonly user: AccountProfile }
  /** The session is gone on purpose; nothing on the page may act on it again. */
  | { readonly status: "ended"; readonly reason: "deleted" | "signed-out-everywhere" };

export type AccountPageAction =
  | { readonly type: "LOADED"; readonly user: AccountProfile | null }
  | { readonly type: "LOAD_FAILED"; readonly message: string }
  | { readonly type: "USER_UPDATED"; readonly user: AccountProfile }
  | { readonly type: "ENDED"; readonly reason: "deleted" | "signed-out-everywhere" };

export function accountPageReducer(
  state: AccountPageState,
  action: AccountPageAction
): AccountPageState {
  switch (action.type) {
    case "LOADED":
      if (state.status !== "loading") return state;
      return action.user ? { status: "ready", user: action.user } : { status: "signed-out" };
    case "LOAD_FAILED":
      return state.status === "loading" ? { status: "failed", message: action.message } : state;
    case "USER_UPDATED":
      // A save that lands after the account ended, or for another account, is dropped.
      return state.status === "ready" && state.user.id === action.user.id
        ? { status: "ready", user: action.user }
        : state;
    case "ENDED":
      return state.status === "ready" ? { status: "ended", reason: action.reason } : state;
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

export type VerifyState =
  | { readonly status: "ready" }
  | { readonly status: "confirming" }
  | { readonly status: "done"; readonly purpose: "verify" | "change"; readonly email: string }
  /** `dead` when only a new link can help. */
  | { readonly status: "failed"; readonly message: string; readonly dead: boolean };

export type VerifyAction =
  | { readonly type: "CONFIRM" }
  | { readonly type: "CONFIRMED"; readonly purpose: "verify" | "change"; readonly email: string }
  | { readonly type: "FAILED"; readonly message: string; readonly dead: boolean };

export const VERIFY_START: VerifyState = { status: "ready" };

export function verifyReducer(state: VerifyState, action: VerifyAction): VerifyState {
  switch (action.type) {
    case "CONFIRM":
      return state.status === "ready" || (state.status === "failed" && !state.dead)
        ? { status: "confirming" }
        : state;
    case "CONFIRMED":
      return state.status === "confirming"
        ? { status: "done", purpose: action.purpose, email: action.email }
        : state;
    case "FAILED":
      return state.status === "confirming"
        ? { status: "failed", message: action.message, dead: action.dead }
        : state;
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

/** Reads the account fields from a server reply, or null when the reply has none. */
export function readAccountProfile(reply: unknown): AccountProfile | null {
  const user = (reply as { user?: unknown } | null)?.user;
  if (!user || typeof user !== "object") return null;
  const value = user as Record<string, unknown>;
  if (
    typeof value.id !== "string" ||
    typeof value.email !== "string" ||
    typeof value.displayName !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    email: value.email,
    displayName: value.displayName,
    phone: typeof value.phone === "string" ? value.phone : null,
    emailVerified: value.emailVerified === true,
  };
}
