import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { readJsonObject, rejectCrossSiteRequest } from "@/lib/server/requestGuards";
import { logServerError, logServerEvent, redactLogText } from "@/lib/server/log";

function post(headers: Record<string, string>, body = "{}"): NextRequest {
  return new NextRequest("https://krave.example/api/owner", { method: "POST", headers, body });
}

describe("rejectCrossSiteRequest", () => {
  it("allows same-origin and header-less (non-browser) requests", () => {
    expect(rejectCrossSiteRequest(post({ host: "krave.example", origin: "https://krave.example" }))).toBeNull();
    expect(rejectCrossSiteRequest(post({ host: "krave.example", "sec-fetch-site": "same-origin" }))).toBeNull();
    expect(rejectCrossSiteRequest(post({ host: "krave.example" }))).toBeNull();
  });

  it("refuses cross-site, foreign-origin, opaque and malformed origins", () => {
    const cases: Array<Record<string, string>> = [
      { host: "krave.example", "sec-fetch-site": "cross-site" },
      { host: "krave.example", origin: "https://evil.example" },
      { host: "krave.example", origin: "https://krave.example.evil.example" },
      { host: "krave.example", origin: "null" },
      { host: "krave.example", origin: "not a url" },
    ];
    for (const headers of cases) {
      expect(rejectCrossSiteRequest(post(headers))?.status).toBe(403);
    }
  });
});

describe("readJsonObject", () => {
  it("returns plain objects", async () => {
    const result = await readJsonObject(post({}, '{"name":"Thali"}'));
    expect(result).toEqual({ ok: true, body: { name: "Thali" } });
  });

  it("answers malformed and non-object bodies with 400", async () => {
    for (const body of ["not-json", "null", "[]", '"text"', "42", ""]) {
      const result = await readJsonObject(post({}, body));
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(400);
    }
  });

  it("answers oversized bodies with 413, by header or by actual size", async () => {
    const declared = await readJsonObject(post({ "content-length": "999999" }, "{}"), 1024);
    expect(!declared.ok && declared.response.status).toBe(413);
    const actual = await readJsonObject(post({}, JSON.stringify({ text: "x".repeat(2048) })), 1024);
    expect(!actual.ok && actual.response.status).toBe(413);
  });
});

describe("structured server log", () => {
  afterEach(() => vi.restoreAllMocks());

  it("redacts credentials, keys and emails from free text", () => {
    const text = redactLogText(
      "postgresql://owner:hunter2@db.neon.tech/app Bearer abc.def sk-proj-1234567890abcdef AKIAABCDEFGHIJKLMNOP cook@example.com"
    );
    expect(text).not.toMatch(/hunter2|abc\.def|1234567890abcdef|AKIAABCDEFGHIJKLMNOP|cook@example\.com/);
  });

  it("writes one JSON line and drops sensitive context keys", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cause = Object.assign(new Error("connect failed for postgres://u:p@h/db"), { code: "ECONNREFUSED" });
    logServerError("db_down", new Error("query failed", { cause }), {
      restaurantId: "r1",
      email: "owner@example.com",
      sessionToken: "abc",
    });
    const entry = JSON.parse(String(spy.mock.calls[0][0]));
    expect(entry).toMatchObject({ level: "error", event: "db_down", restaurantId: "r1" });
    expect(entry.email).toBe("[redacted]");
    expect(entry.sessionToken).toBe("[redacted]");
    expect(entry.error.cause.code).toBe("ECONNREFUSED");
    expect(JSON.stringify(entry)).not.toMatch(/u:p@|owner@example\.com/);
  });

  it("routes warnings to console.warn", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logServerEvent("warn", "import_rejected", { importId: "i1" });
    expect(JSON.parse(String(spy.mock.calls[0][0]))).toMatchObject({ level: "warn", importId: "i1" });
  });
});
