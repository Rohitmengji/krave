import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/webroutes/[...slug]/route";
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

