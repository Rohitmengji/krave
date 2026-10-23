import { NextRequest, NextResponse } from "next/server";
import { one } from "@/lib/server/pg";
import { signedInRestaurantUser, requireSignedIn, restaurantApiError } from "@/lib/server/restaurantApi";
import { assertCanManageRestaurant } from "@/lib/server/restaurantStore";
import { getPrivateObjectUrl } from "@/lib/server/restaurantStorage";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ restaurantId: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const { restaurantId } = await params;
    const assetId = request.nextUrl.searchParams.get("assetId");
    if (!assetId) {
      return NextResponse.json({ status: "error", message: "Choose an image." }, { status: 400 });
    }
    await assertCanManageRestaurant(user!.id, restaurantId);
    const asset = await one<{ object_key: string; mime_type: string }>(
      `SELECT object_key, mime_type FROM restaurant_assets
       WHERE id = $1 AND restaurant_id = $2 AND kind = 'menu_item_image'`,
      [assetId, restaurantId]
    );
    if (!asset) {
      return NextResponse.json({ status: "error", message: "Image not found." }, { status: 404 });
    }
    return NextResponse.json({
      status: "success",
      url: await getPrivateObjectUrl(asset.object_key),
      mimeType: asset.mime_type,
    });
  } catch (error) {
    return restaurantApiError(error);
  }
}
