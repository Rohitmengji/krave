import { NextRequest, NextResponse } from "next/server";
import { requireSignedIn, restaurantApiError, signedInRestaurantUser } from "@/lib/server/restaurantApi";
import { readJsonObject, rejectCrossSiteRequest } from "@/lib/server/requestGuards";
import { grantTeamAccess, listTeam, revokeTeamAccess } from "@/lib/server/restaurantTeam";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ restaurantId: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const { restaurantId } = await params;
    return NextResponse.json({ status: "success", ...(await listTeam(user!.id, restaurantId)) });
  } catch (error) {
    return restaurantApiError(error);
  }
}

/** Adds someone by the email of their KRAVE account, or changes their role: `{ email, role }`. */
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
    return NextResponse.json({
      status: "success",
      ...(await grantTeamAccess(user!.id, restaurantId, parsed.body)),
    });
  } catch (error) {
    return restaurantApiError(error);
  }
}

/** Removes someone's access: `{ userId }`. */
export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const crossSite = rejectCrossSiteRequest(request);
    if (crossSite) return crossSite;
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const { restaurantId } = await params;
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return parsed.response;
    return NextResponse.json({
      status: "success",
      ...(await revokeTeamAccess(user!.id, restaurantId, parsed.body)),
    });
  } catch (error) {
    return restaurantApiError(error);
  }
}
