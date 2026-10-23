import { NextRequest, NextResponse } from "next/server";
import { readJsonObject, rejectCrossSiteRequest } from "@/lib/server/requestGuards";
import { requireSignedIn, restaurantApiError, signedInRestaurantUser } from "@/lib/server/restaurantApi";
import {
  changeRestaurantOrderStatus,
  listRestaurantOrders,
  type OrderListView,
} from "@/lib/server/restaurantOrderStore";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ restaurantId: string }> };

const VIEWS: readonly OrderListView[] = ["active", "done", "all"];

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const { restaurantId } = await params;
    const viewParam = request.nextUrl.searchParams.get("view") ?? "active";
    if (!VIEWS.includes(viewParam as OrderListView)) {
      return NextResponse.json({ status: "error", message: "Choose active, done or all." }, { status: 400 });
    }
    const view = viewParam as OrderListView;
    // The live queue is polled whole; only history pages.
    const page = await listRestaurantOrders(user!.id, restaurantId, {
      view,
      before: view === "active" ? null : request.nextUrl.searchParams.get("before"),
      limit: view === "active" ? 100 : 25,
    });
    return NextResponse.json({ status: "success", ...page }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return restaurantApiError(error);
  }
}

/** Moves an order one step along its lifecycle: `{ orderId, from, to, reason? }`. */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const crossSite = rejectCrossSiteRequest(request);
    if (crossSite) return crossSite;
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const { restaurantId } = await params;
    const parsed = await readJsonObject(request, 4 * 1024);
    if (!parsed.ok) return parsed.response;
    const order = await changeRestaurantOrderStatus(user!.id, restaurantId, parsed.body);
    return NextResponse.json({ status: "success", order });
  } catch (error) {
    return restaurantApiError(error);
  }
}
