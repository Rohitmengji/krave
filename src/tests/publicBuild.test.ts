import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/webroutes/[...slug]/route";
import { closePool, getPool } from "@/lib/server/pg";
import {
  BRAND_THEME_PRESETS,
  COLLECTIONS_DATA,
  COUPON_OFFERS,
  RESTAURANTS_DATA,
  SAVED_ADDRESSES,
  TOP_BRANDS_DATA,
} from "@/data/zomatoReconstructedData";

// Real businesses that earlier builds named. A public deployment must not imply they take
// orders here. Stable ids such as "ctl_dal_bukhara" stay, so saved carts keep resolving.
const REAL_BRANDS =
  /haldiram|bukhara|farzi|lavonne|biryani blues|mount fuji|out of the box|\bITC\b|\baxis\b|zomato|hyperpure|\bgold \d/i;
// FSSAI licence format: 14 digits, starting 1 (licence) or 2 (registration). A real one would
// attribute a business's regulatory id to a restaurant that does not exist.
const LICENCE_NUMBER = /\b[12]\d{13}\b/;

function customerVisibleText(value: unknown): string {
  const strings: string[] = [];
  JSON.stringify(value, (key, field) => {
    if (key === "id" || /(Id|_id)$/.test(key)) return undefined;
    if (typeof field === "string") strings.push(field);
    return field;
  });
  return strings.join("\n");
}

function get(pathname: string) {
  return GET(new NextRequest(`http://localhost/api/webroutes/${pathname}`), {
    params: Promise.resolve({ slug: pathname.split("/") }),
  });
}

describe("public build", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("ships no restaurants, menus, collections, brands or offers of its own", () => {
    // Customers see only what owners publish to the database; nothing invented can stand in.
    expect(RESTAURANTS_DATA).toEqual([]);
    expect(COLLECTIONS_DATA).toEqual([]);
    expect(TOP_BRANDS_DATA).toEqual([]);
    expect(COUPON_OFFERS).toEqual([]);

    const catalog = customerVisibleText({ BRAND_THEME_PRESETS, SAVED_ADDRESSES });
    expect(catalog.match(REAL_BRANDS)).toBeNull();
    expect(catalog.match(LICENCE_NUMBER)).toBeNull();
  });

  it("keeps the reverse-engineering evidence out of production", async () => {
    expect((await get("rea/evidence")).status).toBe(200);

    vi.stubEnv("NODE_ENV", "production");
    const response = await get("rea/evidence");
    expect(response.status).toBe(404);
    expect(await response.text()).not.toMatch(/zomato/i);
  });

  it("shows customers no third-party brand in the storefront shell", () => {
    const source = readFileSync(path.resolve(__dirname, "../components/KraveApp.tsx"), "utf8");
    // The import path is internal; any capitalised mention would be rendered or registered.
    expect(source).not.toMatch(/Zomato|zomato_webmcp/);
    expect(source).toMatch(/SHOW_DEVELOPER_INSPECTOR && \(/);

    // The inspector is development-only, so it may name what it inspected.
    const componentsDir = path.resolve(__dirname, "../components");
    for (const file of readdirSync(componentsDir).filter((name) => /\.tsx$/.test(name))) {
      if (file === "ReaInspectorModal.tsx") continue;
      const text = readFileSync(path.join(componentsDir, file), "utf8");
      expect(text, file).not.toMatch(/Zomato|Hyperpure|FSSAI #/);
    }
  });

  it("declares a tab and install icon that the build serves", async () => {
    // Without a declared icon, browsers request /favicon.ico, which 404s, and a shared
    // link opens with a blank tab.
    const { metadata } = await import("@/app/layout");
    const { default: manifest } = await import("@/app/manifest");
    const declared = (value: unknown) =>
      [...JSON.stringify(value ?? null).matchAll(/"(\/[^"?#]+)/g)].map((match) => match[1]);

    const pageIcons = declared(metadata.icons);
    const installIcons = declared(manifest().icons);
    expect(pageIcons).not.toHaveLength(0);
    expect(installIcons).not.toHaveLength(0);
    for (const url of [...pageIcons, ...installIcons]) {
      expect(existsSync(path.resolve(__dirname, "../../public", url.slice(1))), url).toBe(true);
    }
  });
});

describe("database pool on Vercel", () => {
  const requestContext = Symbol.for("@vercel/request-context");

  afterEach(async () => {
    vi.useRealTimers();
    delete (globalThis as Record<symbol, unknown>)[requestContext];
    vi.unstubAllEnvs();
    await closePool();
  });

  // A suspended instance keeps its sockets; Neon drops them meanwhile, so the next request
  // would be handed a dead connection unless the pool drained before the suspend.
  it("keeps the instance awake until released connections have idled out", async () => {
    vi.useFakeTimers();
    vi.stubEnv("DATABASE_URL", "postgresql://krave:secret@db.example.invalid/krave");
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("VERCEL_URL", "krave.vercel.app");
    vi.stubEnv("VERCEL_REGION", "sin1");
    const pending: Promise<unknown>[] = [];
    (globalThis as Record<symbol, unknown>)[requestContext] = {
      get: () => ({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) }),
    };

    const pool = getPool();
    // Short, so an idle instance is not billed for long before it may suspend.
    expect(pool.options.idleTimeoutMillis).toBeLessThanOrEqual(5_000);

    pool.emit("release", undefined, {});
    expect(pending).toHaveLength(1);
    let drained = false;
    void pending[0].then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync((pool.options.idleTimeoutMillis ?? 0) + 100);
    expect(drained).toBe(true);
  });
});
