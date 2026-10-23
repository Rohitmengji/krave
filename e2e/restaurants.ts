import { expect, type Page } from "@playwright/test";
import { signInAsStaff } from "./helpers";

export interface E2eRestaurant {
  id: string;
  slug: string;
  name: string;
}

/**
 * The menu every e2e restaurant gets. Bills are whole rupees plus 5% GST, so Paneer Tikka
 * alone is ₹252 and Paneer Tikka with Chicken Kari (Full) is ₹378.
 */
const MENU = [
  { name: "Paneer Tikka", pricePaise: 24_000, dietaryTags: ["vegetarian"] },
  {
    name: "Chicken Kari",
    pricePaise: 7_000,
    dietaryTags: ["non-vegetarian"],
    variants: [
      { name: "Half", priceDeltaPaise: 0 },
      { name: "Full", priceDeltaPaise: 5_000 },
    ],
  },
];

/**
 * Creates a restaurant with that menu through the owner API, as the staff account (which may
 * create restaurants and bill for every one). It stays a draft unless `publish` is set; the
 * terminal bills drafts too. Names should be unique, since the database is shared by specs.
 * Specs that call this must sort after owner-menu.spec.ts, which needs the staff account to
 * start with no restaurant (files run in name order on one worker).
 */
export async function createRestaurant(
  page: Page,
  name: string,
  { publish = false } = {}
): Promise<E2eRestaurant> {
  await signInAsStaff(page);
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}-${Date.now().toString(36)}`;
  const post = async (url: string, data: Record<string, unknown>) => {
    const response = await page.request.post(url, { data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };

  const { restaurant } = await post("/api/owner", { name, slug, city: "Wadi", state: "Karnataka" });
  const { category } = await post(`/api/owner/${restaurant.id}/menu`, { type: "category", name: "Mains" });
  for (const item of MENU) {
    await post(`/api/owner/${restaurant.id}/menu`, {
      type: "item",
      categoryId: category.id,
      published: true,
      available: true,
      ...item,
    });
  }
  if (publish) await post(`/api/owner/${restaurant.id}`, { action: "publish" });
  return { id: restaurant.id, slug, name };
}

/** Opens the terminal signed in as staff, on this restaurant's floor. */
export async function openTerminal(page: Page, restaurant: E2eRestaurant) {
  await signInAsStaff(page);
  await page.goto("/pos", { waitUntil: "networkidle" });
  await page.getByLabel("Outlet").selectOption({ label: restaurant.name });
}
