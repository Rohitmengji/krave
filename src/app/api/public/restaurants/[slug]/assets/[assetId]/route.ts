import { NextRequest, NextResponse } from "next/server";
import { one } from "@/lib/server/pg";
import { getPublishedRestaurantBySlug } from "@/lib/server/restaurantStore";
import { getPrivateObjectUrl } from "@/lib/server/restaurantStorage";
import { logServerError } from "@/lib/server/log";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ slug: string; assetId: string }> };

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const { slug, assetId } = await params;
    const restaurant = await getPublishedRestaurantBySlug(slug);
    if (!restaurant) {
      return NextResponse.json({ status: "error", message: "Restaurant not found." }, { status: 404 });
    }
    const asset = await one<{ object_key: string }>(
      `SELECT a.object_key
       FROM restaurant_assets a
       JOIN menu_items i ON i.image_asset_id = a.id AND i.restaurant_id = a.restaurant_id
       JOIN menu_categories c ON c.id = i.category_id AND c.restaurant_id = i.restaurant_id
       WHERE a.id = $1 AND a.restaurant_id = $2 AND a.kind = 'menu_item_image'
         AND i.published = 1 AND i.available = 1 AND c.visible = 1`,
      [assetId, restaurant.id]
    );
    if (!asset) {
      return NextResponse.json({ status: "error", message: "Image not found." }, { status: 404 });
    }
    return NextResponse.redirect(await getPrivateObjectUrl(asset.object_key), {
      status: 302,
      // Signed URLs live 15 minutes. Edge (8 min) plus browser (5 min) caching stays inside
      // that, so a cached redirect never points at an expired signature.
      headers: { "Cache-Control": "public, max-age=300, s-maxage=480" },
    });
  } catch (error) {
    logServerError("public_image_failed", error);
    return NextResponse.json(
      { status: "error", message: "The image is temporarily unavailable." },
      { status: 500 }
    );
  }
}
