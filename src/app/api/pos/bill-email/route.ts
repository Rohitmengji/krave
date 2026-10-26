import { NextRequest, NextResponse } from "next/server";
import { publicOrigin } from "@/lib/server/passwordResetMail";
import { emailBill } from "@/lib/server/posBillShare";
import { requireSignedIn, restaurantApiError, signedInRestaurantUser } from "@/lib/server/restaurantApi";
import { readJsonObject, rejectCrossSiteRequest } from "@/lib/server/requestGuards";

export const dynamic = "force-dynamic";

/** Emails a table's bill as a PDF: `{ sessionId, email }`. */
export async function POST(request: NextRequest) {
  try {
    const crossSite = rejectCrossSiteRequest(request);
    if (crossSite) return crossSite;
    const user = await signedInRestaurantUser(request);
    const denied = requireSignedIn(user);
    if (denied) return denied;
    const parsed = await readJsonObject(request);
    if (!parsed.ok) return parsed.response;
    const origin = publicOrigin(request.nextUrl.origin) ?? request.nextUrl.origin;
    return NextResponse.json({ status: "success", ...(await emailBill(user!.id, parsed.body, origin)) });
  } catch (error) {
    return restaurantApiError(error);
  }
}
