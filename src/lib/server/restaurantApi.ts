import { NextRequest, NextResponse } from "next/server";
import { getUserForToken, SESSION_COOKIE, type AccountUser } from "./auth";
import { DatabaseFault } from "./pg";
import { logServerError } from "./log";
import { MENU_ITEM_CONFLICT } from "./restaurantStore";
import { OrderRequestError, orderErrorStatus } from "./restaurantOrderStore";

/** Best-effort client identity for throttling; Vercel sets x-forwarded-for itself. */
export function requestClientKey(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    request.headers.get("x-real-ip") ||
    "local"
  );
}

export async function signedInRestaurantUser(request: NextRequest): Promise<AccountUser | null> {
  return getUserForToken(request.cookies.get(SESSION_COOKIE)?.value);
}

export function restaurantApiError(error: unknown): NextResponse {
  if (error instanceof OrderRequestError) {
    return NextResponse.json(
      { status: "error", code: error.code, message: error.message, ...(error.quote ? { quote: error.quote } : {}) },
      { status: orderErrorStatus(error) }
    );
  }
  if (error instanceof DatabaseFault || (error instanceof Error && Object.getPrototypeOf(error) !== Error.prototype)) {
    logServerError("restaurant_api_failed", error);
    return NextResponse.json(
      { status: "error", message: "Something went wrong on our side. Please try again." },
      { status: 500 }
    );
  }
  if (error instanceof Error && error.message === MENU_ITEM_CONFLICT) {
    return NextResponse.json({ status: "error", message: error.message }, { status: 409 });
  }
  // Quota refusals from reserveClientQuota; "Too many variants…" is a 400 validation error.
  if (error instanceof Error && /^Too many .*\btry again in\b/i.test(error.message)) {
    return NextResponse.json({ status: "error", message: error.message }, { status: 429 });
  }
  if (error instanceof Error && /administrator must approve/i.test(error.message)) {
    return NextResponse.json({ status: "error", message: error.message }, { status: 403 });
  }
  if (error instanceof Error && /do not have access/i.test(error.message)) {
    return NextResponse.json(
      { status: "error", message: "You do not have access to this restaurant." },
      { status: 403 }
    );
  }
  return NextResponse.json(
    {
      status: "error",
      message: error instanceof Error ? error.message : "The request could not be completed.",
    },
    { status: 400 }
  );
}

export function requireSignedIn(user: AccountUser | null): NextResponse | null {
  return user
    ? null
    : NextResponse.json({ status: "error", message: "Sign in to manage your restaurant." }, { status: 401 });
}
