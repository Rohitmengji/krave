import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { signedInRestaurantUser, requireSignedIn, restaurantApiError } from "@/lib/server/restaurantApi";
import { rejectCrossSiteRequest } from "@/lib/server/requestGuards";
import {
  assertCanManageRestaurant,
  createRestaurantAsset,
} from "@/lib/server/restaurantStore";
import {
  deletePrivateObject,
  putPrivateObject,
  RESTAURANT_ASSET_LIMIT_BYTES,
  restaurantStorageConfigured,
  validateRestaurantFile,
  type RestaurantAssetKind,
} from "@/lib/server/restaurantStorage";
import { reserveClientQuota } from "@/lib/server/auth";
import { logServerError } from "@/lib/server/log";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ restaurantId: string }> };

function safeFileName(name: string): string {
  const leaf = name.split(/[\\/]/).pop() ?? "upload";
  return leaf.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "upload";
}

export async function POST(request: NextRequest, { params }: RouteContext) {
  try {
    const crossSite = rejectCrossSiteRequest(request);
    if (crossSite) return crossSite;
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const { restaurantId } = await params;
    await assertCanManageRestaurant(user!.id, restaurantId);
    if (!restaurantStorageConfigured()) {
      return NextResponse.json(
        {
          status: "error",
          message: "File storage is not configured on this server. Add the Neon S3 credentials, then upload again.",
        },
        { status: 503 }
      );
    }
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json({ status: "error", message: "Send the file as a form upload." }, { status: 400 });
    }
    const file = form.get("file");
    const requestedKind = form.get("kind");
    if (!(file instanceof File)) {
      return NextResponse.json({ status: "error", message: "Choose a file to upload." }, { status: 400 });
    }
    if (file.size <= 0 || file.size > RESTAURANT_ASSET_LIMIT_BYTES) {
      return NextResponse.json({ status: "error", message: "Files must be smaller than 4 MB." }, { status: 413 });
    }
    if (requestedKind !== "menu_document" && requestedKind !== "menu_item_image") {
      return NextResponse.json({ status: "error", message: "Choose a menu document or dish image." }, { status: 400 });
    }
    await reserveClientQuota(
      `restaurant-upload:${user!.id}`,
      60,
      "Too many restaurant files uploaded. Try again in 15 minutes."
    );
    const kind: RestaurantAssetKind = requestedKind;

    const bytes = new Uint8Array(await file.arrayBuffer());
    validateRestaurantFile(bytes, file.type, kind);
    const fileName = safeFileName(file.name);
    const objectKey = `restaurants/${restaurantId}/${kind}/${randomUUID()}`;
    await putPrivateObject(objectKey, bytes, file.type);
    try {
      const asset = await createRestaurantAsset({
        userId: user!.id,
        restaurantId,
        objectKey,
        kind: kind as "menu_document" | "menu_item_image",
        fileName,
        mimeType: file.type,
        byteSize: bytes.byteLength,
      });
      return NextResponse.json(
        {
          status: "success",
          assetId: asset.id,
          importId: asset.importJobId ?? null,
          fileName,
          extractionStatus: asset.importJobId ? "uploaded" : null,
          extractionConfigured: Boolean(process.env.OPENAI_API_KEY),
          message: asset.importJobId
            ? process.env.OPENAI_API_KEY
              ? "Menu page saved. Start extraction when you're ready; no AI request has been made yet."
              : "Menu page saved. Set OPENAI_API_KEY to extract its items; the original remains available."
            : undefined,
        },
        { status: 201 }
      );
    } catch (error) {
      try {
        await deletePrivateObject(objectKey);
      } catch (cleanupError) {
        logServerError("upload_cleanup_failed", cleanupError, { restaurantId, objectKey });
      }
      throw error;
    }
  } catch (error) {
    return restaurantApiError(error);
  }
}
