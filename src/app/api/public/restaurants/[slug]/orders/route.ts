import { NextRequest, NextResponse } from "next/server";
import { reserveClientQuota } from "@/lib/server/auth";
import { readJsonObject, rejectCrossSiteRequest } from "@/lib/server/requestGuards";
import { requestClientKey, restaurantApiError, signedInRestaurantUser } from "@/lib/server/restaurantApi";
import { normalizePhone, placeRestaurantOrder } from "@/lib/server/restaurantOrderStore";
import { logServerEvent } from "@/lib/server/log";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ slug: string }> };

/** Places an order from a published managed menu. Guests may order; payment is offline. */
export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const crossSite = rejectCrossSiteRequest(request);
    if (crossSite) return crossSite;
    const parsed = await readJsonObject(request, 32 * 1024);
    if (!parsed.ok) return parsed.response;
    // Counted before any database work. Generous, because mobile carriers put many
    // customers behind one address; a retry of the same checkout counts too.
    await reserveClientQuota(
      `restaurant-order:${requestClientKey(request)}`,
      20,
      "Too many orders from this network. Please try again in 15 minutes or call the restaurant."
    );
    const phone = phoneOrNull(parsed.body.customerPhone);
    if (phone) {
      // Stops one number being used to flood the kitchen with orders nobody will collect.
      await reserveClientQuota(
        `restaurant-order-phone:${phone}`,
        8,
        "Too many orders for this phone number. Please try again in 15 minutes or call the restaurant."
      );
    }
    const { slug } = await params;
    const user = await signedInRestaurantUser(request);
    const placed = await placeRestaurantOrder(slug, parsed.body, user?.id ?? null);
    if (!placed.replayed) {
      logServerEvent("info", "restaurant_order_placed", {
        orderId: placed.order.id,
        restaurant: placed.order.restaurant.slug,
        totalPaise: placed.order.totalPaise,
      });
    }
    return NextResponse.json(
      { status: "success", order: placed.order, replayed: placed.replayed },
      { status: placed.replayed ? 200 : 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    return restaurantApiError(error);
  }
}

function phoneOrNull(value: unknown): string | null {
  try {
    // "+91 98450 12345" and "98450 12345" are the same line.
    return normalizePhone(value).slice(-10);
  } catch {
    // The store reports the invalid number with its own message.
    return null;
  }
}
