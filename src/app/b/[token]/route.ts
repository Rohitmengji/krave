import { NextRequest, NextResponse } from "next/server";
import { logServerError } from "@/lib/server/log";
import { loadSharedBill, sharedBillFileName, sharedBillPdf } from "@/lib/server/posBillShare";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ token: string }> };

const HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" };

/** A guest's bill as a PDF, for whoever has the link. Always the bill as it stands now. */
export async function GET(_request: NextRequest, { params }: RouteContext) {
  const { token } = await params;
  try {
    const shared = await loadSharedBill(token);
    if (!shared) {
      return new NextResponse("This bill link is not valid. Ask the restaurant to send it again.", {
        status: 404,
        headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" },
      });
    }
    return new NextResponse(Buffer.from(sharedBillPdf(shared)), {
      headers: {
        ...HEADERS,
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${sharedBillFileName(shared)}"`,
      },
    });
  } catch (error) {
    logServerError("bill_pdf_failed", error);
    return new NextResponse("The bill could not be opened. Try again in a minute.", {
      status: 500,
      headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}
