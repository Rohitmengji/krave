import { NextRequest, NextResponse } from "next/server";
import { reserveClientQuota } from "@/lib/server/auth";
import { extractMenuFromDocument } from "@/lib/server/menuExtraction";
import { signedInRestaurantUser, requireSignedIn, restaurantApiError } from "@/lib/server/restaurantApi";
import { readJsonObject, rejectCrossSiteRequest } from "@/lib/server/requestGuards";
import {
  claimMenuExtraction,
  failMenuExtraction,
  getMenuDocumentForOwner,
  importReviewedMenuItems,
  saveMenuExtraction,
  updateMenuImportDraft,
} from "@/lib/server/restaurantStore";
import { readPrivateObject, validateRestaurantFile, type RestaurantAssetKind } from "@/lib/server/restaurantStorage";
import { logServerError, logServerEvent } from "@/lib/server/log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

type RouteContext = { params: Promise<{ restaurantId: string; importId: string }> };

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  try {
    const crossSite = rejectCrossSiteRequest(request);
    if (crossSite) return crossSite;
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const { restaurantId, importId } = await params;
    const parsed = await readJsonObject(request, 1024 * 1024);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    const items = await updateMenuImportDraft(user!.id, restaurantId, importId, body.items);
    return NextResponse.json({ status: "success", items });
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
    const { restaurantId, importId } = await params;
    const parsed = await readJsonObject(request, 1024 * 1024);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    if (body.action === "import") {
      const result = await importReviewedMenuItems(user!.id, restaurantId, importId, body.items);
      return NextResponse.json({ status: "success", ...result });
    }
    if (body.action !== "retry") {
      return NextResponse.json({ status: "error", message: "Choose retry or import." }, { status: 400 });
    }
    if (!process.env.OPENAI_API_KEY) {
      return NextResponse.json(
        { status: "error", message: "Set OPENAI_API_KEY before retrying menu extraction." },
        { status: 503 }
      );
    }

    const document = await getMenuDocumentForOwner(user!.id, restaurantId, importId);
    if (!document) {
      return NextResponse.json({ status: "error", message: "Menu import not found." }, { status: 404 });
    }
    if (document.job.status === "imported") {
      return NextResponse.json({ status: "success", job: document.job, alreadyImported: true });
    }
    const claimed = await claimMenuExtraction(user!.id, restaurantId, importId);
    if (!claimed) {
      return NextResponse.json(
        { status: "error", message: "This menu is already being processed or is ready for review. Refresh the page." },
        { status: 409 }
      );
    }

    try {
      await reserveClientQuota(
        `menu-import:${user!.id}`,
        10,
        "Too many menu pages processed. Try again in 15 minutes."
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Too many menu pages processed. Try again in 15 minutes.";
      await failMenuExtraction(user!.id, restaurantId, importId, message);
      return NextResponse.json({ status: "error", message }, { status: 429 });
    }

    try {
      const stored = await readPrivateObject(document.objectKey);
      validateRestaurantFile(stored.bytes, document.mimeType, "menu_document" satisfies RestaurantAssetKind);
      if (stored.contentType !== document.mimeType) {
        throw new Error("The stored menu file did not match its recorded type.");
      }
      const items = await extractMenuFromDocument({
        bytes: stored.bytes,
        mimeType: document.mimeType,
        fileName: document.job.fileName,
      });
      await saveMenuExtraction(user!.id, restaurantId, importId, items);
      return NextResponse.json({ status: "success", extractionStatus: "review", items });
    } catch (error) {
      // Only our own plain Errors carry owner-facing text; timeouts, network, storage and
      // database faults are logged and replaced, so internals never reach the job record.
      const ownMessage = error instanceof Error && Object.getPrototypeOf(error) === Error.prototype;
      const message = ownMessage
        ? error.message
        : error instanceof Error && error.name === "TimeoutError"
          ? "The menu reader took too long. Your file is saved; retry the import."
          : "The menu could not be read. The uploaded file is available for another retry.";
      if (!ownMessage) logServerError("menu_extraction_failed", error, { restaurantId, importId });
      else logServerEvent("warn", "menu_extraction_rejected", { restaurantId, importId, reason: message });
      await failMenuExtraction(user!.id, restaurantId, importId, message);
      return NextResponse.json(
        { status: "error", message, fileRetained: true },
        { status: 502 }
      );
    }
  } catch (error) {
    return restaurantApiError(error);
  }
}
