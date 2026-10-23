/**
 * Password reset rules and screen state, shared by the browser and the server. Nothing here
 * touches the server, so client components may import it.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
export const RESET_LINK_MINUTES = 30;
export const RESET_PAGE_PATH = "/reset-password";
export const SIGN_IN_PATH = "/signin";

/** The token rides in the fragment, which browsers never send to a server or in a Referer. */
export function resetLink(origin: string, token: string): string {
  return `${origin}${RESET_PAGE_PATH}#token=${encodeURIComponent(token)}`;
}

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{20,200}$/;

/** The token from a reset link's fragment, or null when the link is missing or mangled. */
export function readResetToken(hash: string): string | null {
  const token = new URLSearchParams(hash.replace(/^#/, "")).get("token");
  return token !== null && TOKEN_SHAPE.test(token) ? token : null;
}

/** Same limits the server enforces, checked first so a typo costs no round trip. */
export function newPasswordProblem(password: string, confirmation: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`;
  }
  if (password !== confirmation) return "The two passwords don't match.";
  return null;
}

/** "server-log" only in development without SMTP, where the link goes to the terminal. */
export type ResetDelivery = "email" | "server-log";

export function readResetDelivery(reply: unknown): ResetDelivery {
  const delivery = (reply as { delivery?: unknown } | null)?.delivery;
  return delivery === "server-log" ? "server-log" : "email";
}

export type ForgotState =
  | { readonly status: "editing"; readonly error: string | null }
  | { readonly status: "sending" }
  | { readonly status: "sent"; readonly email: string; readonly delivery: ResetDelivery };

export type ForgotAction =
  | { readonly type: "SEND" }
  | { readonly type: "SENT"; readonly email: string; readonly delivery: ResetDelivery }
  | { readonly type: "FAILED"; readonly message: string }
  | { readonly type: "EDIT" };

export const FORGOT_START: ForgotState = { status: "editing", error: null };

export function forgotReducer(state: ForgotState, action: ForgotAction): ForgotState {
  switch (action.type) {
    case "SEND":
      return state.status === "sending" ? state : { status: "sending" };
    case "SENT":
      return state.status === "sending"
        ? { status: "sent", email: action.email, delivery: action.delivery }
        : state;
    case "FAILED":
      return state.status === "sending" ? { status: "editing", error: action.message } : state;
    case "EDIT":
      return state.status === "sending" ? state : { status: "editing", error: null };
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}

export type ResetState =
  | { readonly status: "editing"; readonly error: string | null }
  | { readonly status: "saving" }
  | { readonly status: "link-dead"; readonly message: string };

export type ResetAction =
  | { readonly type: "SAVE" }
  /** A problem the person can fix on this screen: a rule, a typo, a dropped connection. */
  | { readonly type: "REFUSED"; readonly message: string }
  /** The link itself is spent, expired or invalid; only a new email helps. */
  | { readonly type: "LINK_DEAD"; readonly message: string };

export const RESET_START: ResetState = { status: "editing", error: null };

export function resetReducer(state: ResetState, action: ResetAction): ResetState {
  switch (action.type) {
    case "SAVE":
      return state.status === "editing" ? { status: "saving" } : state;
    case "REFUSED":
      return state.status === "link-dead" ? state : { status: "editing", error: action.message };
    case "LINK_DEAD":
      return state.status === "saving" ? { status: "link-dead", message: action.message } : state;
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}
