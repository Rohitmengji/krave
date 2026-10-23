import { NextRequest, NextResponse } from "next/server";
import { signedInRestaurantUser, requireSignedIn, restaurantApiError } from "@/lib/server/restaurantApi";
import { readJsonObject, rejectCrossSiteRequest } from "@/lib/server/requestGuards";
import {
  createMenuCategory,
  deleteMenuCategory,
  deleteMenuItem,
  getManagedMenu,
  saveMenuItem,
  setMenuItemAvailability,
  updateMenuCategory,
} from "@/lib/server/restaurantStore";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ restaurantId: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
  try {
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const { restaurantId } = await params;
    const categories = await getManagedMenu(user!.id, restaurantId);
    return NextResponse.json({ status: "success", categories });
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
    if (body.type === "category") {
      const category = await createMenuCategory(user!.id, restaurantId, body);
      return NextResponse.json({ status: "success", category }, { status: 201 });
    }
    if (body.type === "item") {
      const item = await saveMenuItem(user!.id, restaurantId, body);
      return NextResponse.json({ status: "success", item }, { status: body.id ? 200 : 201 });
    }
    return NextResponse.json({ status: "error", message: "Choose a category or menu item." }, { status: 400 });
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
    const body = parsed.body;
    if (body.type === "category" && typeof body.id === "string") {
      await updateMenuCategory(user!.id, restaurantId, body.id, body);
      return NextResponse.json({ status: "success" });
    }
    if (body.type === "item") {
      const item = await saveMenuItem(user!.id, restaurantId, body);
      return NextResponse.json({ status: "success", item });
    }
    if (body.type === "itemAvailability") {
      const item = await setMenuItemAvailability(user!.id, restaurantId, body);
      return NextResponse.json({ status: "success", item });
    }
    return NextResponse.json({ status: "error", message: "Choose a category or menu item." }, { status: 400 });
  } catch (error) {
    return restaurantApiError(error);
  }
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  try {
    const crossSite = rejectCrossSiteRequest(request);
    if (crossSite) return crossSite;
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const { restaurantId } = await params;
    const search = request.nextUrl.searchParams;
    const categoryId = search.get("categoryId");
    const itemId = search.get("itemId");
    if (categoryId) {
      await deleteMenuCategory(user!.id, restaurantId, categoryId);
    } else if (itemId) {
      await deleteMenuItem(user!.id, restaurantId, itemId);
    } else {
      return NextResponse.json({ status: "error", message: "Choose a category or menu item." }, { status: 400 });
    }
    return NextResponse.json({ status: "success" });
  } catch (error) {
    return restaurantApiError(error);
  }
}
