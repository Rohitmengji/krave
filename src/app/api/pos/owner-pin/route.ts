import { NextRequest, NextResponse } from "next/server";
import { requireSignedIn, restaurantApiError, signedInRestaurantUser } from "@/lib/server/restaurantApi";
import { readJsonObject, rejectCrossSiteRequest } from "@/lib/server/requestGuards";
import { confirmPosOwnerPin, POS_PIN_WRONG } from "@/lib/server/posOwnerPin";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const crossSite = rejectCrossSiteRequest(request);
    if (crossSite) return crossSite;
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return parsed.response;
    await confirmPosOwnerPin(user!.id, parsed.body);
    return NextResponse.json({ status: "success" });
  } catch (error) {
    if (error instanceof Error && error.message === POS_PIN_WRONG) {
      return NextResponse.json({ status: "error", message: error.message }, { status: 403 });
    }
    return restaurantApiError(error);
  }
}
