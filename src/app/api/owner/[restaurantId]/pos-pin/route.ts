import { NextRequest, NextResponse } from "next/server";
import {
  requestClientKey,
  requireSignedIn,
  restaurantApiError,
  signedInRestaurantUser,
} from "@/lib/server/restaurantApi";
import { readJsonObject, rejectCrossSiteRequest } from "@/lib/server/requestGuards";
import { hasPosOwnerPin, setPosOwnerPin } from "@/lib/server/posOwnerPin";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ restaurantId: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const { restaurantId } = await params;
    return NextResponse.json({ status: "success", pinSet: await hasPosOwnerPin(user!.id, restaurantId) });
  } catch (error) {
    return restaurantApiError(error);
  }
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const crossSite = rejectCrossSiteRequest(request);
    if (crossSite) return crossSite;
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const { restaurantId } = await params;
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return parsed.response;
    await setPosOwnerPin(user!.id, restaurantId, parsed.body, requestClientKey(request));
    return NextResponse.json({ status: "success", pinSet: true });
  } catch (error) {
    return restaurantApiError(error);
  }
}
