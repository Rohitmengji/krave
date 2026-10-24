import { NextRequest, NextResponse } from "next/server";
import { requireSignedIn, restaurantApiError, signedInRestaurantUser } from "@/lib/server/restaurantApi";
import { listSalesHistory, SalesHistoryAccessError } from "@/lib/server/posHistory";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const history = await listSalesHistory(user!.id, request.nextUrl.searchParams);
    return NextResponse.json(
      { status: "success", ...history },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof SalesHistoryAccessError) {
      return NextResponse.json({ status: "error", message: error.message }, { status: 403 });
    }
    return restaurantApiError(error);
  }
}
