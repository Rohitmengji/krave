import { NextRequest, NextResponse } from "next/server";
import { signedInRestaurantUser, requireSignedIn, restaurantApiError } from "@/lib/server/restaurantApi";
import { listMenuImportJobs } from "@/lib/server/restaurantStore";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ restaurantId: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const { restaurantId } = await params;
    const imports = await listMenuImportJobs(user!.id, restaurantId);
    return NextResponse.json({ status: "success", imports });
  } catch (error) {
    return restaurantApiError(error);
  }
}
