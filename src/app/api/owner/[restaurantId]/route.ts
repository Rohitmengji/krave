import { NextRequest, NextResponse } from "next/server";
import { signedInRestaurantUser, requireSignedIn, restaurantApiError } from "@/lib/server/restaurantApi";
import { readJsonObject, rejectCrossSiteRequest } from "@/lib/server/requestGuards";
import {
  assertCanManageRestaurant,
  changeRestaurantPublication,
  getManagedMenu,
  getOpeningHours,
  listMenuImportJobs,
  listManagedRestaurants,
  updateManagedRestaurant,
} from "@/lib/server/restaurantStore";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ restaurantId: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const { restaurantId } = await params;
    const restaurant = (await listManagedRestaurants(user!.id)).find((item) => item.id === restaurantId);
    if (!restaurant) {
      await assertCanManageRestaurant(user!.id, restaurantId);
      return NextResponse.json({ status: "error", message: "Restaurant not found." }, { status: 404 });
    }
    const [categories, imports, hours] = await Promise.all([
      getManagedMenu(user!.id, restaurantId),
      listMenuImportJobs(user!.id, restaurantId),
      getOpeningHours(restaurantId),
    ]);
    return NextResponse.json({ status: "success", restaurant, categories, imports, hours });
  } catch (error) {
    return restaurantApiError(error);
  }
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const crossSite = rejectCrossSiteRequest(request);
    if (crossSite) return crossSite;
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const { restaurantId } = await params;
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return parsed.response;
    const restaurant = await updateManagedRestaurant(user!.id, restaurantId, parsed.body);
    return NextResponse.json({ status: "success", restaurant });
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
    const body = parsed.body;
    if (body.action !== "publish" && body.action !== "unpublish") {
      return NextResponse.json({ status: "error", message: "Choose publish or unpublish." }, { status: 400 });
    }
    const restaurant = await changeRestaurantPublication(
      user!.id,
      restaurantId,
      body.action === "publish"
    );
    return NextResponse.json({ status: "success", restaurant });
  } catch (error) {
    return restaurantApiError(error);
  }
}
