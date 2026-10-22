import { NextRequest, NextResponse } from "next/server";
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
  createPasswordReset,
  createSession,
  destroySession,
  getUserForToken,
  registerUser,
  resetPassword,
  revokeAllSessions,
  SESSION_COOKIE,
  setGoldMembership,
  verifyCredentials,
  type AccountUser,
} from "@/lib/server/auth";
import {
  advanceOrderStage,
  deleteOrder,
  findOrderByIdempotencyKey,
  hasVisited,
  listBookmarks,
  listOrders,
  listReservations,
  saveOrder,
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
import { fileDispute, listDisputes } from "@/lib/server/disputeStore";

/** Account endpoints touch per-request cookies, so this segment must never be prerendered. */
export const dynamic = "force-dynamic";

function currentUser(request: NextRequest): AccountUser | null {
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

function accountPayload(user: AccountUser) {
  // Any read is a chance to start a window that has come due; there is no scheduler.
  sweepScheduledOrders(user.id);
  return {
    status: "success",
    user,
    orders: listOrders(user.id),
    reservations: listReservations(user.id),
    bookmarks: listBookmarks(user.id),
    notifications: listNotifications(user.id),
    unavailableItemIds: listUnavailableItems(),
    dineInBills: listDineInBills(user.id),
    disputes: listDisputes(user.id),
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

function failed(error: unknown, fallback: string, status = 400) {
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
          pageUrl: `/ncr/${mode}`,
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
    const resId = Number(searchParams.get("resId") || RESTAURANTS_DATA[0].resId);
    const restaurant =
      RESTAURANTS_DATA.find((r) => r.resId === resId) || RESTAURANTS_DATA[0];
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
        protocol: "Zomato Crystal Post-Order Engine v2",
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
    return NextResponse.json({
      status: "success",
      webroute: routePath,
      evidence: REA_EVIDENCE_SUMMARY,
      coupons: COUPON_OFFERS,
      addresses: SAVED_ADDRESSES,
    });
  }

  if (routePath === "/webroutes/kitchen/tickets") {
    const user = currentUser(request);
    if (!user) return failed(null, "Sign in to open the counter.", 401);
    const rawOutletId = searchParams.get("outletId");
    const outletId = rawOutletId === null ? null : Number(rawOutletId);
    if (outletId === null || !Number.isSafeInteger(outletId)) {
      return failed(null, "Provide the outlet to show tickets for.");
    }
    return NextResponse.json({
      status: "success",
      tickets: listDeliveryTickets(outletId),
      prepTime: prepTimeStats(outletId),
    });
  }

  if (routePath === "/webroutes/account/me") {
    const user = currentUser(request);
    if (!user) {
      // A signed-out browser still needs the live 86 list to render an honest menu.
      return NextResponse.json({
        status: "success",
        user: null,
        guest: true,
        unavailableItemIds: listUnavailableItems(),
      });
    }
    return NextResponse.json(accountPayload(user));
  }

  if (routePath === "/webroutes/menu/availability") {
    // Number(null) is 0, so the parameter's presence is checked before coercing it.
    const rawOutletId = searchParams.get("outletId");
    const outletId = rawOutletId === null ? null : Number(rawOutletId);
    return NextResponse.json({
      status: "success",
      unavailableItemIds:
        outletId !== null && Number.isSafeInteger(outletId)
          ? listUnavailableItems(outletId)
          : listUnavailableItems(),
    });
  }

  if (routePath === "/webroutes/pos/state") {
    const user = currentUser(request);
    if (!user) return failed(null, "Sign in to sync this terminal.", 401);
    return NextResponse.json({ status: "success", ...loadPosState(user.id) });
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
    destroySession(request.cookies.get(SESSION_COOKIE)?.value);
    const response = NextResponse.json({ status: "success", user: null });
    response.cookies.delete(SESSION_COOKIE);
    return response;
  }

  if (routePath === "/webroutes/auth/logout-everywhere") {
    const user = currentUser(request);
    if (!user) return failed(null, "Sign in first.", 401);
    revokeAllSessions(user.id);
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
          ? await registerUser(body)
          : await verifyCredentials(body, clientKey(request));
      const { token, expiresAt } = createSession(user.id);
      return withSessionCookie(
        NextResponse.json(accountPayload(user), { status: 201 }),
        token,
        expiresAt
      );
    } catch (error) {
      return failed(error, "Could not sign you in.");
    }
  }

  if (routePath === "/webroutes/auth/forgot") {
    const reset = createPasswordReset(body);
    if (reset) {
      // No mail provider here. A real deployment emails this instead of logging it.
      console.info(
        `[krave] password reset token (expires ${reset.expiresAt.toISOString()}): ${reset.token}`
      );
    }
    // Always identical, so an unknown address cannot be distinguished from a known one.
    return NextResponse.json({
      status: "success",
      message: "If that account exists, a reset link has been issued.",
    });
  }

  if (routePath === "/webroutes/auth/reset") {
    const { token, password } = (body ?? {}) as Record<string, unknown>;
    try {
      await resetPassword(token, password, clientKey(request));
      const response = NextResponse.json({ status: "success", user: null });
      response.cookies.delete(SESSION_COOKIE);
      return response;
    } catch (error) {
      return failed(error, "Could not reset that password.");
    }
  }

  if (routePath === "/webroutes/account/membership") {
    const user = currentUser(request);
    if (!user) return failed(null, "Sign in to change membership.", 401);
    const isGoldMember = (body as Record<string, unknown>)?.isGoldMember;
    if (typeof isGoldMember !== "boolean") {
      return failed(null, "Membership value must be true or false.");
    }
    setGoldMembership(user.id, isGoldMember);
    return NextResponse.json(accountPayload({ ...user, isGoldMember }));
  }

  if (routePath === "/webroutes/account/bookmarks") {
    const user = currentUser(request);
    if (!user) return failed(null, "Sign in to save bookmarks.", 401);
    try {
      return NextResponse.json({
        status: "success",
        bookmarks: setBookmarks(user.id, (body as Record<string, unknown>)?.bookmarks),
      });
    } catch (error) {
      return failed(error, "Could not save bookmarks.");
    }
  }

  if (routePath === "/webroutes/order/stage") {
    const user = currentUser(request);
    if (!user) return failed(null, "Sign in to update an order.", 401);
    const { orderId, stage } = (body ?? {}) as Record<string, unknown>;
    if (typeof orderId !== "string" || !ORDER_STAGES.some((candidate) => candidate === stage)) {
      return failed(null, "Provide an order and a known stage.");
    }
    try {
      advanceOrderStage(user.id, orderId, stage as string);
      return NextResponse.json({ status: "success", orders: listOrders(user.id) });
    } catch (error) {
      return failed(error, "Could not update that order.");
    }
  }

  if (routePath === "/webroutes/order/cancel") {
    const user = currentUser(request);
    if (!user) return failed(null, "Sign in to cancel an order.", 401);
    const orderId = (body as Record<string, unknown>)?.orderId;
    if (typeof orderId !== "string") return failed(null, "Provide an order to cancel.");
    try {
      deleteOrder(user.id, orderId);
      return NextResponse.json({ status: "success", orders: listOrders(user.id) });
    } catch (error) {
      return failed(error, "Could not cancel that order.");
    }
  }

  if (routePath === "/webroutes/pos/sync") {
    const user = currentUser(request);
    if (!user) return failed(null, "Sign in to sync this terminal.", 401);
    try {
      return NextResponse.json({ status: "success", ...syncPosState(user.id, body) });
    } catch (error) {
      return failed(error, "Could not sync this terminal.");
    }
  }

  if (routePath === "/webroutes/menu/availability") {
    const user = currentUser(request);
    // Taking a dish off affects every customer of that outlet, so it needs an operator.
    if (!user) return failed(null, "Sign in to change what the kitchen is serving.", 401);
    try {
      const result = setDishAvailability(user.id, body);
      return NextResponse.json({ status: "success", ...result });
    } catch (error) {
      return failed(error, "Could not update that dish.");
    }
  }

  if (routePath === "/webroutes/account/notifications/read") {
    const user = currentUser(request);
    if (!user) return failed(null, "Sign in to read notifications.", 401);
    markNotificationsRead(user.id);
    return NextResponse.json({ status: "success", notifications: listNotifications(user.id) });
  }

  if (routePath === "/webroutes/account/notifications/clear") {
    const user = currentUser(request);
    if (!user) return failed(null, "Sign in to clear notifications.", 401);
    clearNotifications(user.id);
    return NextResponse.json({ status: "success", notifications: [] });
  }

  if (routePath === "/webroutes/kitchen/ticket") {
    const user = currentUser(request);
    if (!user) return failed(null, "Sign in to work the counter.", 401);
    const { orderId, status } = (body ?? {}) as Record<string, unknown>;
    try {
      return NextResponse.json({
        status: "success",
        ticket: advanceDeliveryTicket(orderId, status),
      });
    } catch (error) {
      return failed(error, "Could not update that ticket.");
    }
  }

  if (routePath === "/webroutes/account/dispute") {
    const user = currentUser(request);
    if (!user) {
      return NextResponse.json(
        { status: "error", message: "Sign in to raise a claim." },
        { status: 401 }
      );
    }
    try {
      const claim = body as Record<string, unknown>;
      const dispute = fileDispute(user.id, {
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
      addNotification(
        user.id,
        "SYSTEM",
        dispute.status === "AUTO_REFUNDED"
          ? `Refund of ₹${dispute.refundAmount} approved`
          : "Your claim is being reviewed",
        dispute.explanation
      );
      return NextResponse.json({ ...accountPayload(user), dispute }, { status: 201 });
    } catch (error) {
      return failed(error, "Could not raise that claim.");
    }
  }

  if (routePath === "/webroutes/account/claim-bill") {
    const user = currentUser(request);
    if (!user) return failed(null, "Sign in to add a table bill to your history.", 401);
    try {
      const bill = claimDineInBill(user.id, body);
      addNotification(
        user.id,
        "SYSTEM",
        `Table bill added from ${bill.outletName}`,
        `Table ${bill.tableId} · ₹${bill.grandTotal} · now in your history.`
      );
      return NextResponse.json({ ...accountPayload(user), bill });
    } catch (error) {
      return failed(error, "That code is not valid or has already been used.");
    }
  }

  if (routePath === "/webroutes/order/cart") {
    try {
      const validated = validateCheckout(body);
      assertItemsAvailable(validated.items, listUnavailableItems());
      const lockToken = issueQuoteLock(validated.items, validated.quote.grandTotal);
      return NextResponse.json({
        status: "success",
        quote: validated.quote,
        priceLock: lockToken,
        priceLockMinutes: lockToken ? QUOTE_LOCK_MINUTES : 0,
        demo: true,
      });
    } catch (error) {
      return NextResponse.json({ status: "error", message: error instanceof Error ? error.message : "Invalid cart." }, { status: 400 });
    }
  }

  if (routePath === "/webroutes/order/makeOrder" || routePath === "/webroutes/placeorder") {
    try {
      const user = currentUser(request);
      const idempotencyKey = request.headers.get("idempotency-key");
      if (user) {
        // Replaying the same key returns the original order instead of charging the guest twice.
        const existing = findOrderByIdempotencyKey(user.id, idempotencyKey);
        if (existing) {
          return NextResponse.json({ status: "success", order: existing, replayed: true });
        }
      }

      // Checked here rather than inside the validator, so replaying an old order from
      // history never fails because something sold out after it was delivered.
      assertItemsAvailable(validateCheckout(body).items, listUnavailableItems());

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
      createDeliveryTicket(order);
      if (user) {
        saveOrder(user.id, order, {
          addressId: String((body as Record<string, unknown>).addressId),
          idempotencyKey,
        });
        addNotification(
          user.id,
          "ORDER",
          `Demo order confirmed at ${order.restaurantName}`,
          order.scheduledSlot === "ASAP"
            ? `Arriving in about ${order.etaMinutes} minutes. No payment was collected.`
            : `Scheduled for ${order.scheduledSlot}. No payment was collected.`
        );
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
      const user = currentUser(request);
      if (user) {
        saveReservation(user.id, reservation);
        addNotification(
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
      const reviewer = currentUser(request);
      const resId = Number((body as Record<string, unknown>).resId);
      const verifiedPurchase = reviewer ? hasVisited(reviewer.id, resId) : false;

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
      return NextResponse.json(
        {
          status: "error",
          message: error instanceof Error ? error.message : "Invalid review submission.",
        },
        { status: 400 }
      );
    }
  }

  return NextResponse.json({ status: "error", message: "Endpoint not implemented." }, { status: 404 });
}
