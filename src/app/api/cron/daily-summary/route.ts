import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { sendDailySummaries } from "@/lib/server/dailySummary";
import { publicOrigin } from "@/lib/server/passwordResetMail";

export const dynamic = "force-dynamic";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; nothing else may start a run. */
function fromCron(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(header ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json({ status: "error", message: "The morning summary is not set up." }, { status: 503 });
  }
  if (!fromCron(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ status: "error", message: "Not allowed." }, { status: 401 });
  }
  const origin = publicOrigin(request.nextUrl.origin);
  if (!origin) {
    return NextResponse.json({ status: "error", message: "Set KRAVE_PUBLIC_URL." }, { status: 503 });
  }
  try {
    const result = await sendDailySummaries(new Date(), origin);
    return NextResponse.json({ status: "success", ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[krave] Daily summary run failed.", error);
    return NextResponse.json({ status: "error", message: "The summary run failed." }, { status: 500 });
  }
}
