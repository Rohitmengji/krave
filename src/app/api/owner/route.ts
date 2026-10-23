import { NextRequest, NextResponse } from "next/server";
import { signedInRestaurantUser, requireSignedIn, restaurantApiError } from "@/lib/server/restaurantApi";
import { readJsonObject, rejectCrossSiteRequest } from "@/lib/server/requestGuards";
import {
  createManagedRestaurant,
  isRestaurantAdmin,
  listManagedRestaurants,
} from "@/lib/server/restaurantStore";
import { restaurantStorageConfigured } from "@/lib/server/restaurantStorage";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const [restaurants, isAdmin] = await Promise.all([
      listManagedRestaurants(user!.id),
      isRestaurantAdmin(user!.id),
    ]);
    return NextResponse.json({
      status: "success",
      user: { id: user!.id, email: user!.email, displayName: user!.displayName },
      isAdmin,
      canCreateRestaurant: isAdmin,
      menuImportConfigured: Boolean(process.env.OPENAI_API_KEY),
      uploadsConfigured: restaurantStorageConfigured(),
      restaurants,
    });
  } catch (error) {
    return restaurantApiError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const crossSite = rejectCrossSiteRequest(request);
    if (crossSite) return crossSite;
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return parsed.response;
    const restaurant = await createManagedRestaurant(user!.id, parsed.body);
    return NextResponse.json({ status: "success", restaurant }, { status: 201 });
  } catch (error) {
    return restaurantApiError(error);
  }
}
