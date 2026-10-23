import { NextRequest, NextResponse } from "next/server";

/**
 * Defence in depth on top of the SameSite=Lax session cookie: a state-changing request
 * that a browser labels cross-site, or whose Origin names another host, is refused
 * before any authentication or body parsing happens.
 */
export function rejectCrossSiteRequest(request: NextRequest): NextResponse | null {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite === "cross-site") return forbidden();

  const origin = request.headers.get("origin");
  if (origin === null) return null;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
  try {
    if (origin === "null" || new URL(origin).host !== host) return forbidden();
  } catch {
    return forbidden();
  }
  return null;
}

function forbidden(): NextResponse {
  return NextResponse.json(
    { status: "error", message: "This request must come from the KRAVE site itself." },
    { status: 403 }
  );
}

export const JSON_BODY_LIMIT_BYTES = 256 * 1024;

export type JsonBodyResult = { ok: true; body: Record<string, unknown> } | { ok: false; response: NextResponse };

/** Malformed, non-object or oversized JSON is the caller's mistake (400/413), never a 500. */
export async function readJsonObject(request: NextRequest, limit = JSON_BODY_LIMIT_BYTES): Promise<JsonBodyResult> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    return { ok: false, response: tooLarge() };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: badBody() };
  }
  if (new TextEncoder().encode(text).byteLength > limit) {
    return { ok: false, response: tooLarge() };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, response: badBody() };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, response: badBody() };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

function badBody(): NextResponse {
  return NextResponse.json({ status: "error", message: "Send a valid JSON request body." }, { status: 400 });
}

function tooLarge(): NextResponse {
  return NextResponse.json({ status: "error", message: "The request body is too large." }, { status: 413 });
}
