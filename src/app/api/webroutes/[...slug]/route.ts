import { after, NextRequest, NextResponse } from "next/server";
import {
  COLLECTIONS_DATA,
  COUPON_OFFERS,
  REA_EVIDENCE_SUMMARY,
  RESTAURANTS_DATA,
  SAVED_ADDRESSES,
  TOP_BRANDS_DATA,
} from "@/data/zomatoReconstructedData";
import { filterAndSortRestaurants } from "@/lib/cartEngine";
import { DiscoveryTabKey } from "@/types/krave";
import {
  assertItemsAvailable,
  createDemoOrder,
  createValidatedReservation,
  createValidatedReview,
  ORDER_STAGES,
  validateCheckout,
} from "@/lib/checkout";
import {
  applyQuoteLock,
  issueQuoteLock,
  QUOTE_LOCK_MINUTES,
} from "@/lib/server/quoteLock";
import {
  changePassword,
  createSession,
  deleteAccount,
  DELETE_BLOCKED_BY_RESTAURANT,
  DELETE_BLOCKED_BY_STAFF_ACCESS,
  destroySession,
  getUserForToken,
  LOGIN_WINDOW_MINUTES,
  MAX_GUEST_ORDERS_PER_CLIENT,
  normalizeEmail,
  PASSWORD_CHANGED_ELSEWHERE,
  REAUTH_THROTTLED,
  registerUser,
  reserveClientQuota,
  reservePasswordResetRequest,
  RESET_LINK_INVALID,
  RESET_LINK_SPENT,
  resetPassword,
  revokeAllSessions,
  SESSION_COOKIE,
  setGoldMembership,
  verifyCredentials,
  type AccountUser,
} from "@/lib/server/auth";
import {
  ACCOUNT_EMAILS_THROTTLED,
  confirmEmailToken,
  createVerificationToken,
  EMAIL_LINK_SPENT,
  EMAIL_LINK_STALE,
  EMAIL_TAKEN,
  requestEmailChange,
  requestVerification,
  updateProfile,
} from "@/lib/server/accountService";
import { deliverEmailLink, notifyAccountDeleted, notifyEmailChanged } from "@/lib/server/accountMail";
import {
  deliverPasswordReset,
  notifyPasswordChanged,
  publicOrigin,
  mailChannel,
  type MailChannel,
} from "@/lib/server/passwordResetMail";
import {
  advanceOrderStage,
  deleteOrder,
  findOrderByIdempotencyKey,
  hasVisited,
  listBookmarks,
  listOrders,
  listReservations,
  placeOrder,
  saveReservation,
  setBookmarks,
  addNotification,
  clearNotifications,
  listNotifications,
  markNotificationsRead,
  sweepScheduledOrders,
} from "@/lib/server/accountStore";
import { loadPosState, syncPosState } from "@/lib/server/posStore";
import { listUnavailableItems, setDishAvailability } from "@/lib/server/menuStore";
import {
  advanceDeliveryTicket,
  createDeliveryTicket,
  listDeliveryTickets,
  prepTimeStats,
} from "@/lib/server/kitchenStore";
import { claimDineInBill, listDineInBills } from "@/lib/server/dineInStore";
import { fileDispute, listDisputeQueue, listDisputes, resolveDispute } from "@/lib/server/disputeStore";
import { isAnyOutletStaff, isOutletStaff } from "@/lib/server/staff";

/** Account endpoints touch per-request cookies, so this segment must never be prerendered. */
export const dynamic = "force-dynamic";

async function currentUser(request: NextRequest): Promise<AccountUser | null> {
  return getUserForToken(request.cookies.get(SESSION_COOKIE)?.value);
}

/** Best-effort client identity for throttling. Behind a proxy this needs a trusted header. */
function clientKey(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0].trim() ||
    request.headers.get("x-real-ip") ||
    "local"
  );
}

/** Status for a refusal the customer can read and act on. */
function refusalStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : "";
  if (message === REAUTH_THROTTLED || message === ACCOUNT_EMAILS_THROTTLED) return 429;
  if (
    message === DELETE_BLOCKED_BY_STAFF_ACCESS ||
    message === DELETE_BLOCKED_BY_RESTAURANT ||
    message === PASSWORD_CHANGED_ELSEWHERE ||
    message === EMAIL_TAKEN
  ) {
    return 409;
  }
  return 400;
}

function emailUnavailable() {
  return NextResponse.json(
    { status: "error", message: "Email isn't set up on this server yet, so links can't be sent." },
    { status: 503 }
  );
}

/** Emails a new account its confirmation link. Never fails the sign-up itself. */
function sendWelcomeVerification(user: AccountUser, request: NextRequest): void {
  let channel: MailChannel | null;
  try {
    channel = mailChannel(request.nextUrl.origin);
  } catch (error) {
    console.error("[krave] Could not send the email confirmation.", error);
    return;
  }
  // The server log is a `next dev` convenience; any other run without mail sends nothing.
  if (!channel || (channel.kind === "server-log" && process.env.NODE_ENV !== "development")) {
    return;
  }
  const reachable = channel;
  after(async () => {
    try {
      const token = await createVerificationToken(user);
      await deliverEmailLink(reachable, "verify", user.email, token, user.email);
    } catch (error) {
      console.error("[krave] Could not send the email confirmation.", error);
    }
  });
}

async function accountPayload(user: AccountUser) {
  // Any read is a chance to start a window that has come due; there is no scheduler.
  await sweepScheduledOrders(user.id);
  // Independent reads, so they go out together rather than one round trip after another.
  const [orders, reservations, bookmarks, notifications, unavailableItemIds, dineInBills, disputes] =
    await Promise.all([
      listOrders(user.id),
      listReservations(user.id),
      listBookmarks(user.id),
      listNotifications(user.id),
      listUnavailableItems(),
      listDineInBills(user.id),
      listDisputes(user.id),
    ]);
  return {
    status: "success",
    user,
    orders,
    reservations,
    bookmarks,
    notifications,
    unavailableItemIds,
    dineInBills,
    disputes,
  };
}

function withSessionCookie(
  response: NextResponse,
  token: string,
  expiresAt: Date
): NextResponse {
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
  return response;
}

/**
 * Store and validation code throws plain `Error`s whose messages are written for the
 * customer. Anything else (a DatabaseFault, a TypeError from a bug) is logged and answered
 * with a generic 500, so connection strings and constraint names never reach the browser.
 */
function failed(error: unknown, fallback: string, status = 400) {
  if (error instanceof Error && Object.getPrototypeOf(error) !== Error.prototype) {
    console.error(`[krave] ${fallback}`, error);
    return NextResponse.json(
      { status: "error", message: "Something went wrong on our side. Please try again." },
      { status: 500 }
    );
  }
  return NextResponse.json(
    { status: "error", message: error instanceof Error ? error.message : fallback },
    { status }
  );
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> }
) {
  const { slug } = await params;
  const routePath = `/webroutes/${slug.join("/")}`;
  const searchParams = request.nextUrl.searchParams;

  if (routePath === "/webroutes/getPage") {
    const mode = (searchParams.get("context") || "delivery") as DiscoveryTabKey;
    const query = searchParams.get("q") || "";
    const restaurants = filterAndSortRestaurants(RESTAURANTS_DATA, { mode, query });

    return NextResponse.json({
      status: "success",
      webroute: routePath,
      pages: {
        current: {
          name: "search",
          subType: mode,
          pageUrl: `/${mode}`,
        },
        search: {
          sections: {
            SECTION_SEARCH_TABS: ["delivery", "dineout", "nightlife"],
            SECTION_COLLECTIONS: COLLECTIONS_DATA,
            SECTION_TOP_BRANDS: TOP_BRANDS_DATA,
            SECTION_SEARCH_RESULT: restaurants,
          },
        },
      },
    });
  }

  if (routePath === "/webroutes/restaurant/info" || routePath === "/webroutes/menu/viewMenu") {
    const resId = Number(searchParams.get("resId"));
    const restaurant = RESTAURANTS_DATA.find((r) => r.resId === resId);
    if (!restaurant) {
      return NextResponse.json({ status: "error", message: "Restaurant not found." }, { status: 404 });
    }
    return NextResponse.json({
      status: "success",
      webroute: routePath,
      restaurant,
    });
  }

  if (
    routePath === "/webroutes/postOrder/pollCrystalData" ||
    routePath === "/webroutes/postOrder/getRiderStatus"
  ) {
    return NextResponse.json({
      status: "success",
      webroute: routePath,
      crystal: {
        protocol: "KRAVE Crystal Post-Order Engine v2",
        rider: {
          name: "Rajesh Kumar",
          vehicleNumber: "DL-01-EV-4829",
          vaccinated: true,
          temperature: "98.2°F",
          rating: "4.9",
        },
      },
    });
  }

  if (routePath === "/webroutes/rea/evidence") {
    // Development-only, like the inspector that reads it.
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json({ status: "error", message: "Not found." }, { status: 404 });
    }
    return NextResponse.json({
      status: "success",
      webroute: routePath,
      evidence: REA_EVIDENCE_SUMMARY,
      coupons: COUPON_OFFERS,
      addresses: SAVED_ADDRESSES,
    });
  }

  if (routePath === "/webroutes/kitchen/tickets") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to open the counter.", 401);
    const rawOutletId = searchParams.get("outletId");
    const outletId = rawOutletId === null ? null : Number(rawOutletId);
    if (outletId === null || !Number.isSafeInteger(outletId)) {
      return failed(null, "Provide the outlet to show tickets for.");
    }
    if (!(await isOutletStaff(user.id, outletId))) {
      return failed(null, "You do not have access to this outlet.", 403);
    }
    const [tickets, prepTime] = await Promise.all([
      listDeliveryTickets(outletId),
      prepTimeStats(outletId),
    ]);
    return NextResponse.json({ status: "success", tickets, prepTime });
  }

  if (routePath === "/webroutes/account/me") {
    const user = await currentUser(request);
    if (!user) {
      // A signed-out browser still needs the live 86 list to render an honest menu.
      return NextResponse.json({
        status: "success",
        user: null,
        guest: true,
        unavailableItemIds: await listUnavailableItems(),
      });
    }
    return NextResponse.json(await accountPayload(user));
  }

  if (routePath === "/webroutes/ops/disputes") {
    const user = await currentUser(request);
    if (!user) {
      return NextResponse.json(
        { status: "error", message: "Sign in to see the claims queue." },
        { status: 401 }
      );
    }
    if (!(await isAnyOutletStaff(user.id))) {
      return failed(null, "You do not have access to this outlet.", 403);
    }
    return NextResponse.json({ status: "success", queue: await listDisputeQueue(user.id) });
  }

  if (routePath === "/webroutes/menu/availability") {
    // Number(null) is 0, so the parameter's presence is checked before coercing it.
    const rawOutletId = searchParams.get("outletId");
    const outletId = rawOutletId === null ? null : Number(rawOutletId);
    return NextResponse.json({
      status: "success",
      unavailableItemIds:
        outletId !== null && Number.isSafeInteger(outletId)
          ? await listUnavailableItems(outletId)
          : await listUnavailableItems(),
    });
  }

  if (routePath === "/webroutes/pos/state") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to sync this terminal.", 401);
    return NextResponse.json({ status: "success", ...(await loadPosState(user.id)) });
  }

  return NextResponse.json({ status: "error", message: "Endpoint not implemented." }, { status: 404 });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> }
) {
  const { slug } = await params;
  const routePath = `/webroutes/${slug.join("/")}`;

  // The sign-out routes carry no payload, so they run before a JSON body is required.
  if (routePath === "/webroutes/auth/logout") {
    await destroySession(request.cookies.get(SESSION_COOKIE)?.value);
    const response = NextResponse.json({ status: "success", user: null });
    response.cookies.delete(SESSION_COOKIE);
    return response;
  }

  if (routePath === "/webroutes/auth/logout-everywhere") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in first.", 401);
    await revokeAllSessions(user.id);
    const response = NextResponse.json({ status: "success", user: null });
    response.cookies.delete(SESSION_COOKIE);
    return response;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ status: "error", message: "Invalid JSON request." }, { status: 400 });
  }

  if (routePath === "/webroutes/auth/register" || routePath === "/webroutes/auth/login") {
    try {
      const user =
        routePath === "/webroutes/auth/register"
          ? await registerUser(body, clientKey(request))
          : await verifyCredentials(body, clientKey(request));
      const { token, expiresAt } = await createSession(user.id);
      if (routePath === "/webroutes/auth/register") sendWelcomeVerification(user, request);
      return withSessionCookie(
        NextResponse.json(await accountPayload(user), { status: 201 }),
        token,
        expiresAt
      );
    } catch (error) {
      return failed(error, "Could not sign you in.");
    }
  }

  if (routePath === "/webroutes/auth/forgot") {
    let channel: MailChannel | null;
    try {
      channel = mailChannel(request.nextUrl.origin);
    } catch (error) {
      return failed(error, "Could not send a reset link.");
    }
    // A token that cannot be delivered must not exist: it would only ever be useful to
    // someone reading the server's logs.
    if (!channel) {
      return NextResponse.json(
        {
          status: "error",
          message: "Password reset by email is not available yet.",
        },
        { status: 503 }
      );
    }
    let email: string;
    try {
      email = normalizeEmail((body as { email?: unknown } | null)?.email);
    } catch (error) {
      return failed(error, "Enter a valid email address.");
    }
    try {
      await reservePasswordResetRequest(email, clientKey(request));
    } catch (error) {
      return failed(error, "Too many reset requests.", 429);
    }
    const reachable = channel;
    // After the response, so a known address answers exactly as fast as an unknown one.
    after(() =>
      deliverPasswordReset(email, reachable).catch((error: unknown) => {
        console.error("[krave] Could not deliver a password reset.", error);
      })
    );
    // Always identical, so an unknown address cannot be distinguished from a known one.
    return NextResponse.json({
      status: "success",
      message: "If that account exists, a reset link is on its way.",
      delivery: channel.kind,
    });
  }

  if (routePath === "/webroutes/auth/reset") {
    const { token, password } = (body ?? {}) as Record<string, unknown>;
    try {
      const { email } = await resetPassword(token, password, clientKey(request));
      const origin = publicOrigin(request.nextUrl.origin);
      if (email && origin) {
        after(() =>
          notifyPasswordChanged(email, origin).catch((error: unknown) => {
            console.error("[krave] Could not send the password-changed notice.", error);
          })
        );
      }
      const response = NextResponse.json({ status: "success", user: null });
      response.cookies.delete(SESSION_COOKIE);
      return response;
    } catch (error) {
      // Gone rather than a 400: no new password fixes it, only a new link does.
      if (
        error instanceof Error &&
        (error.message === RESET_LINK_INVALID || error.message === RESET_LINK_SPENT)
      ) {
        return failed(error, RESET_LINK_SPENT, 410);
      }
      return failed(error, "Could not reset that password.");
    }
  }

  // The link in a confirmation email is the proof, so this needs no session.
  if (routePath === "/webroutes/auth/verify-email") {
    try {
      const confirmed = await confirmEmailToken((body as { token?: unknown } | null)?.token);
      if (confirmed.purpose === "change") {
        const origin = publicOrigin(request.nextUrl.origin);
        if (origin) {
          after(() =>
            notifyEmailChanged(confirmed.previousEmail, confirmed.email, origin).catch(
              (error: unknown) => {
                console.error("[krave] Could not send the email-changed notice.", error);
              }
            )
          );
        }
      }
      return NextResponse.json({
        status: "success",
        purpose: confirmed.purpose,
        email: confirmed.email,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === EMAIL_LINK_SPENT || error.message === EMAIL_LINK_STALE)
      ) {
        return failed(error, EMAIL_LINK_SPENT, 410);
      }
      return failed(error, "Could not confirm that email address.", refusalStatus(error));
    }
  }

  if (routePath === "/webroutes/account/profile") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to update your profile.", 401);
    try {
      return NextResponse.json({ status: "success", user: await updateProfile(user.id, body) });
    } catch (error) {
      return failed(error, "Could not save your profile.");
    }
  }

  if (routePath === "/webroutes/account/password") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to change your password.", 401);
    try {
      await changePassword(
        user.id,
        request.cookies.get(SESSION_COOKIE)?.value,
        body,
        clientKey(request)
      );
    } catch (error) {
      return failed(error, "Could not change your password.", refusalStatus(error));
    }
    const origin = publicOrigin(request.nextUrl.origin);
    if (origin) {
      after(() =>
        notifyPasswordChanged(user.email, origin, "settings").catch((error: unknown) => {
          console.error("[krave] Could not send the password-changed notice.", error);
        })
      );
    }
    return NextResponse.json({ status: "success" });
  }

  if (routePath === "/webroutes/account/email") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to change your email address.", 401);
    let channel: MailChannel | null;
    try {
      channel = mailChannel(request.nextUrl.origin);
    } catch (error) {
      return failed(error, "Could not send a confirmation link.");
    }
    if (!channel) return emailUnavailable();
    let change: { email: string; token: string };
    try {
      change = await requestEmailChange(user, body, clientKey(request));
    } catch (error) {
      return failed(error, "Could not start the email change.", refusalStatus(error));
    }
    const reachable = channel;
    after(() =>
      deliverEmailLink(reachable, "change", change.email, change.token, user.email).catch(
        (error: unknown) => {
          console.error("[krave] Could not send the email-change link.", error);
        }
      )
    );
    return NextResponse.json({
      status: "success",
      pendingEmail: change.email,
      delivery: reachable.kind,
    });
  }

  if (routePath === "/webroutes/account/verify-email/resend") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to confirm your email address.", 401);
    let channel: MailChannel | null;
    try {
      channel = mailChannel(request.nextUrl.origin);
    } catch (error) {
      return failed(error, "Could not send a confirmation link.");
    }
    if (!channel) return emailUnavailable();
    let token: string | null;
    try {
      token = await requestVerification(user);
    } catch (error) {
      return failed(error, "Could not send a confirmation link.", refusalStatus(error));
    }
    if (token === null) return failed(null, "Your email address is already confirmed.", 409);
    const issued = token;
    const reachable = channel;
    after(() =>
      deliverEmailLink(reachable, "verify", user.email, issued, user.email).catch(
        (error: unknown) => {
          console.error("[krave] Could not send the email confirmation.", error);
        }
      )
    );
    return NextResponse.json({ status: "success", delivery: reachable.kind });
  }

  if (routePath === "/webroutes/account/delete") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to delete your account.", 401);
    try {
      await deleteAccount(user.id, body, clientKey(request));
    } catch (error) {
      return failed(error, "Could not delete your account.", refusalStatus(error));
    }
    after(() =>
      notifyAccountDeleted(user.email).catch((error: unknown) => {
        console.error("[krave] Could not send the account-deleted notice.", error);
      })
    );
    const response = NextResponse.json({ status: "success", user: null });
    response.cookies.delete(SESSION_COOKIE);
    return response;
  }

  if (routePath === "/webroutes/account/membership") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to change membership.", 401);
    const isGoldMember = (body as Record<string, unknown>)?.isGoldMember;
    if (typeof isGoldMember !== "boolean") {
      return failed(null, "Membership value must be true or false.");
    }
    await setGoldMembership(user.id, isGoldMember);
    return NextResponse.json(await accountPayload({ ...user, isGoldMember }));
  }

  if (routePath === "/webroutes/account/bookmarks") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to save bookmarks.", 401);
    try {
      return NextResponse.json({
        status: "success",
        bookmarks: await setBookmarks(user.id, (body as Record<string, unknown>)?.bookmarks),
      });
    } catch (error) {
      return failed(error, "Could not save bookmarks.");
    }
  }

  if (routePath === "/webroutes/order/stage") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to update an order.", 401);
    const { orderId, stage } = (body ?? {}) as Record<string, unknown>;
    if (typeof orderId !== "string" || !ORDER_STAGES.some((candidate) => candidate === stage)) {
      return failed(null, "Provide an order and a known stage.");
    }
    try {
      await advanceOrderStage(user.id, orderId, stage as string);
      return NextResponse.json({ status: "success", orders: await listOrders(user.id) });
    } catch (error) {
      return failed(error, "Could not update that order.");
    }
  }

  if (routePath === "/webroutes/order/cancel") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to cancel an order.", 401);
    const orderId = (body as Record<string, unknown>)?.orderId;
    if (typeof orderId !== "string") return failed(null, "Provide an order to cancel.");
    try {
      await deleteOrder(user.id, orderId);
      return NextResponse.json({ status: "success", orders: await listOrders(user.id) });
    } catch (error) {
      return failed(error, "Could not cancel that order.");
    }
  }

  if (routePath === "/webroutes/pos/sync") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to sync this terminal.", 401);
    try {
      return NextResponse.json({ status: "success", ...(await syncPosState(user.id, body)) });
    } catch (error) {
      return failed(error, "Could not sync this terminal.");
    }
  }

  if (routePath === "/webroutes/menu/availability") {
    const user = await currentUser(request);
    // Taking a dish off affects every customer of that outlet, so it needs an operator.
    if (!user) return failed(null, "Sign in to change what the kitchen is serving.", 401);
    try {
      const result = await setDishAvailability(user.id, body);
      return NextResponse.json({ status: "success", ...result });
    } catch (error) {
      return failed(error, "Could not update that dish.");
    }
  }

  if (routePath === "/webroutes/account/notifications/read") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to read notifications.", 401);
    await markNotificationsRead(user.id);
    return NextResponse.json({
      status: "success",
      notifications: await listNotifications(user.id),
    });
  }

  if (routePath === "/webroutes/account/notifications/clear") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to clear notifications.", 401);
    await clearNotifications(user.id);
    return NextResponse.json({ status: "success", notifications: [] });
  }

  if (routePath === "/webroutes/kitchen/ticket") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to work the counter.", 401);
    const { orderId, status } = (body ?? {}) as Record<string, unknown>;
    try {
      return NextResponse.json({
        status: "success",
        ticket: await advanceDeliveryTicket(user.id, orderId, status),
      });
    } catch (error) {
      return failed(error, "Could not update that ticket.");
    }
  }

  if (routePath === "/webroutes/ops/dispute/resolve") {
    const user = await currentUser(request);
    if (!user) {
      return NextResponse.json(
        { status: "error", message: "Sign in to settle a claim." },
        { status: 401 }
      );
    }
    try {
      const payload = body as Record<string, unknown>;
      const dispute = await resolveDispute(user.id, {
        disputeId: String(payload.disputeId),
        approve: payload.approve === true,
        note: typeof payload.note === "string" ? payload.note : undefined,
      });
      return NextResponse.json({
        status: "success",
        dispute,
        queue: await listDisputeQueue(user.id),
      });
    } catch (error) {
      return failed(error, "Could not settle that claim.");
    }
  }

  if (routePath === "/webroutes/account/dispute") {
    const user = await currentUser(request);
    if (!user) {
      return NextResponse.json(
        { status: "error", message: "Sign in to raise a claim." },
        { status: 401 }
      );
    }
    try {
      const claim = body as Record<string, unknown>;
      const dispute = await fileDispute(user.id, {
        orderId: String(claim.orderId),
        reason: String(claim.reason),
        lines: Array.isArray(claim.lines)
          ? claim.lines.map((entry) => {
              const line = entry as Record<string, unknown>;
              return { itemId: String(line.itemId), quantity: Number(line.quantity) };
            })
          : [],
        note: typeof claim.note === "string" ? claim.note : undefined,
      });
      await addNotification(
        user.id,
        "SYSTEM",
        dispute.status === "AUTO_REFUNDED"
          ? `Refund of ₹${dispute.refundAmount} approved`
          : "Your claim is being reviewed",
        dispute.explanation
      );
      return NextResponse.json({ ...(await accountPayload(user)), dispute }, { status: 201 });
    } catch (error) {
      return failed(error, "Could not raise that claim.");
    }
  }

  if (routePath === "/webroutes/account/claim-bill") {
    const user = await currentUser(request);
    if (!user) return failed(null, "Sign in to add a table bill to your history.", 401);
    try {
      const bill = await claimDineInBill(user.id, body);
      await addNotification(
        user.id,
        "SYSTEM",
        `Table bill added from ${bill.outletName}`,
        `Table ${bill.tableId} · ₹${bill.grandTotal} · now in your history.`
      );
      return NextResponse.json({ ...(await accountPayload(user)), bill });
    } catch (error) {
      return failed(error, "That code is not valid or has already been used.");
    }
  }

  if (routePath === "/webroutes/order/cart") {
    try {
      const validated = validateCheckout(body);
      assertItemsAvailable(validated.items, await listUnavailableItems());
      const lockToken = issueQuoteLock(validated.items, validated.quote.grandTotal);
      return NextResponse.json({
        status: "success",
        quote: validated.quote,
        priceLock: lockToken,
        priceLockMinutes: lockToken ? QUOTE_LOCK_MINUTES : 0,
        demo: true,
      });
    } catch (error) {
      return failed(error, "Invalid cart.");
    }
  }

  if (routePath === "/webroutes/order/makeOrder" || routePath === "/webroutes/placeorder") {
    try {
      const user = await currentUser(request);
      const idempotencyKey = request.headers.get("idempotency-key");
      if (user) {
        // Replaying the same key returns the original order instead of charging the guest twice.
        const existing = await findOrderByIdempotencyKey(user.id, idempotencyKey);
        if (existing) {
          return NextResponse.json({ status: "success", order: existing, replayed: true });
        }
      }

      // Checked here rather than inside the validator, so replaying an old order from
      // history never fails because something sold out after it was delivered.
      assertItemsAvailable(validateCheckout(body).items, await listUnavailableItems());

      const order = createDemoOrder(body);

      // A lock caps the price; it never overrides a sell-out, which is checked above.
      const lock = applyQuoteLock(
        typeof (body as Record<string, unknown>).priceLock === "string"
          ? String((body as Record<string, unknown>).priceLock)
          : null,
        order.items,
        order.quote.grandTotal
      );
      order.quote.lockAdjustment = order.quote.grandTotal - lock.payable;
      order.quote.grandTotal = lock.payable;
      order.quote.totalSavings += order.quote.lockAdjustment;

      // The outlet's counter gets the ticket whether or not the customer has an account.
      // For an account, the ticket commits with the order, so a replayed key adds neither.
      if (user) {
        const placed = await placeOrder(
          user.id,
          order,
          { addressId: String((body as Record<string, unknown>).addressId), idempotencyKey },
          {
            title: `Demo order confirmed at ${order.restaurantName}`,
            body:
              order.scheduledSlot === "ASAP"
                ? `Arriving in about ${order.etaMinutes} minutes. No payment was collected.`
                : `Scheduled for ${order.scheduledSlot}. No payment was collected.`,
          }
        );
        if (!placed) {
          // A concurrent retry with this key won the insert while this one was validating.
          const existing = await findOrderByIdempotencyKey(user.id, idempotencyKey);
          if (existing) {
            return NextResponse.json({ status: "success", order: existing, replayed: true });
          }
          return failed(null, "This order was already placed.", 409);
        }
      } else {
        // A guest order needs no account, so the kitchen display is protected per address.
        await reserveClientQuota(
          `guest-order:${clientKey(request)}`,
          MAX_GUEST_ORDERS_PER_CLIENT,
          `Too many guest orders from this network. Sign in, or try again in ${LOGIN_WINDOW_MINUTES} minutes.`
        );
        await createDeliveryTicket(order);
      }
      return NextResponse.json(
        { status: "success", order, persisted: Boolean(user), demo: true },
        { status: 201 }
      );
    } catch (error) {
      return failed(error, "Invalid checkout.");
    }
  }

  if (routePath === "/webroutes/user/booking") {
    try {
      const reservation = createValidatedReservation(body);
      const user = await currentUser(request);
      if (user) {
        await saveReservation(user.id, reservation);
        await addNotification(
          user.id,
          "RESERVATION",
          `Table confirmed at ${reservation.restaurantName}`,
          `${reservation.date} at ${reservation.timeSlot} for ${reservation.guests} guests · ${reservation.bookingId}`
        );
      }
      return NextResponse.json(
        {
          status: "success",
          webroute: routePath,
          reservation,
          persisted: Boolean(user),
          demo: true,
        },
        { status: 201 }
      );
    } catch (error) {
      return failed(error, "Invalid reservation request.");
    }
  }

  if (routePath === "/webroutes/reviews/post") {
    try {
      // Verification is decided here from stored history, never taken from the request.
      const reviewer = await currentUser(request);
      const resId = Number((body as Record<string, unknown>).resId);
      const verifiedPurchase = reviewer ? await hasVisited(reviewer.id, resId) : false;

      const review = createValidatedReview(body, { verifiedPurchase });
      return NextResponse.json(
        {
          status: "success",
          webroute: routePath,
          review,
          demo: true,
        },
        { status: 201 }
      );
    } catch (error) {
      return failed(error, "Invalid review submission.");
    }
  }

  return NextResponse.json({ status: "error", message: "Endpoint not implemented." }, { status: 404 });
}
