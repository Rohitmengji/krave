import { NextRequest, NextResponse } from "next/server";
import { readJsonObject, rejectCrossSiteRequest } from "@/lib/server/requestGuards";
import { restaurantApiError } from "@/lib/server/restaurantApi";
import { cancelOrderByCustomer, getPublicRestaurantOrder } from "@/lib/server/restaurantOrderStore";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ orderId: string }> };

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * The order id is a random 128-bit value handed only to the customer who placed it, so it
 * acts as the key to its status page. The response omits the phone number and address.
 */
export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { orderId } = await params;
    const order = await getPublicRestaurantOrder(orderId);
    if (!order) {
      return NextResponse.json({ status: "error", message: "Order not found." }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json({ status: "success", order }, { headers: NO_STORE });
  } catch (error) {
    return restaurantApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const crossSite = rejectCrossSiteRequest(request);
    if (crossSite) return crossSite;
    const parsed = await readJsonObject(request, 1024);
    if (!parsed.ok) return parsed.response;
    if (parsed.body.action !== "cancel") {
      return NextResponse.json({ status: "error", message: "Unknown action." }, { status: 400 });
    }
    const { orderId } = await params;
    const order = await cancelOrderByCustomer(orderId);
    return NextResponse.json({ status: "success", order }, { headers: NO_STORE });
  } catch (error) {
    return restaurantApiError(error);
  }
}
