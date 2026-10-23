import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
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
  /haldiram|bukhara|farzi|lavonne|biryani blues|mount fuji|out of the box|\bITC\b|\baxis\b|zomato/i;

function customerVisibleText(value: unknown): string {
  return JSON.stringify(value, (key, field) =>
    key === "id" || /(Id|_id)$/.test(key) ? undefined : field
  );
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

  it("names only fictional restaurants, brands and offers", () => {
    const catalog = customerVisibleText({
      BRAND_THEME_PRESETS,
      COLLECTIONS_DATA,
      COUPON_OFFERS,
      RESTAURANTS_DATA,
      SAVED_ADDRESSES,
      TOP_BRANDS_DATA,
    });
    expect(catalog.match(REAL_BRANDS)).toBeNull();
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
