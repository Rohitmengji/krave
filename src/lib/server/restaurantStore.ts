import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { one, rows, run, transaction, type Queryable } from "./pg";
import { isValidClockTime, WEEKDAY_NAMES, type OpeningHours } from "@/lib/managedOrders";

const RESTAURANT_ADMIN_EMAILS = [
  ...(process.env.KRAVE_STAFF_EMAILS ?? "").split(","),
  ...(process.env.KRAVE_RESTAURANT_ADMIN_EMAILS ?? "").split(","),
]
  .map((email) => email.trim().toLowerCase())
  .filter(Boolean);

export const MENU_ITEM_CONFLICT =
  "This dish was changed on another device or tab. The latest version has been loaded; review it and save again.";

export type RestaurantStatus = "draft" | "pending" | "published" | "suspended";
export type RestaurantRole = "owner" | "admin" | "manager" | "staff";

export interface ManagedRestaurant {
  id: string;
  ownerUserId: string;
  slug: string;
  name: string;
  description: string;
  phone: string | null;
  email: string | null;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  serviceAreas: string[];
  deliveryEnabled: boolean;
  takeawayEnabled: boolean;
  dineInEnabled: boolean;
  minimumOrderPaise: number;
  deliveryFeePaise: number;
  taxRateBps: number;
  taxEnabled: boolean;
  /** Whether customers may place orders from the public menu right now. */
  acceptingOrders: boolean;
  /** IANA zone the opening hours are written in. */
  timeZone: string;
  status: RestaurantStatus;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface MenuVariant {
  id: string;
  name: string;
  priceDeltaPaise: number;
  available: boolean;
}

export interface MenuAddon {
  id: string;
  name: string;
  pricePaise: number;
  available: boolean;
}

export interface ManagedMenuItem {
  id: string;
  categoryId: string;
  name: string;
  description: string;
  pricePaise: number;
  discountedPricePaise: number | null;
  dietaryTags: string[];
  allergens: string[];
  portionSize: string;
  prepMinutes: number | null;
  spicyLevel: number | null;
  available: boolean;
  published: boolean;
  featured: boolean;
  imageAssetId: string | null;
  displayOrder: number;
  sourceImportId: string | null;
  /** Bumped on every save; updates must send the revision they were based on. */
  revision: number;
  variants: MenuVariant[];
  addons: MenuAddon[];
}

export interface ManagedMenuCategory {
  id: string;
  name: string;
  displayOrder: number;
  visible: boolean;
  items: ManagedMenuItem[];
}

export interface ExtractedMenuItem {
  id: string;
  categoryName: string;
  name: string;
  description: string;
  pricePaise: number | null;
  dietaryTags: string[];
  allergens: string[];
  portionSize: string;
  variants: { name: string; pricePaise: number | null }[];
  sourcePage: number;
  sourceText: string;
  confidence: number | null;
  warnings: string[];
}

export interface MenuImportJob {
  id: string;
  restaurantId: string;
  sourceAssetId: string;
  fileName: string;
  status: "uploaded" | "processing" | "review" | "failed" | "imported";
  extractedItems: ExtractedMenuItem[];
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ImportedReviewItem {
  id: string;
  categoryName: string;
  name: string;
  description: string;
  pricePaise: number | null;
  dietaryTags: string[];
  allergens: string[];
  portionSize: string;
  variants: { name: string; pricePaise: number | null }[];
  sourcePage: number;
  sourceText: string;
  confidence: number | null;
  warnings: string[];
}

type RestaurantRow = Record<string, unknown>;

function text(value: unknown): string {
  return value == null ? "" : String(value);
}

function nullableText(value: unknown): string | null {
  return value == null || value === "" ? null : String(value);
}

function jsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function mapRestaurant(row: RestaurantRow): ManagedRestaurant {
  return {
    id: text(row.id),
    ownerUserId: text(row.owner_user_id),
    slug: text(row.slug),
    name: text(row.name),
    description: text(row.description),
    phone: nullableText(row.phone),
    email: nullableText(row.email),
    address: text(row.address),
    city: text(row.city),
    state: text(row.state),
    postalCode: text(row.postal_code),
    serviceAreas: jsonArray(row.service_areas),
    deliveryEnabled: Number(row.delivery_enabled) === 1,
    takeawayEnabled: Number(row.takeaway_enabled) === 1,
    dineInEnabled: Number(row.dine_in_enabled) === 1,
    minimumOrderPaise: Number(row.minimum_order_paise),
    deliveryFeePaise: Number(row.delivery_fee_paise),
    taxRateBps: Number(row.tax_rate_bps),
    taxEnabled: Number(row.tax_enabled) === 1,
    acceptingOrders: Number(row.accepting_orders) === 1,
    timeZone: text(row.time_zone) || "Asia/Kolkata",
    status: text(row.status) as RestaurantStatus,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
    publishedAt: nullableText(row.published_at),
  };
}

export function isRestaurantAdminEmail(email: string): boolean {
  return RESTAURANT_ADMIN_EMAILS.includes(email.trim().toLowerCase());
}

export async function isRestaurantAdmin(userId: string): Promise<boolean> {
  const user = await one<{ email: string }>("SELECT email FROM users WHERE id = $1", [userId]);
  return Boolean(user && isRestaurantAdminEmail(user.email));
}

export async function assertCanManageRestaurant(
  userId: string,
  restaurantId: string
): Promise<RestaurantRole | "platform_admin"> {
  if (await isRestaurantAdmin(userId)) return "platform_admin";
  const membership = await one<{ role: string }>(
    `SELECT role FROM restaurant_memberships
     WHERE restaurant_id = $1 AND user_id = $2`,
    [restaurantId, userId]
  );
  if (
    membership?.role === "owner" ||
    membership?.role === "admin" ||
    membership?.role === "manager"
  ) {
    return membership.role;
  }
  throw new Error("You do not have access to this restaurant.");
}

/** The restaurants this account runs. Waiters (staff) bill from the table POS instead. */
export async function listManagedRestaurants(userId: string): Promise<ManagedRestaurant[]> {
  const rowsFound = (await isRestaurantAdmin(userId))
    ? await rows<RestaurantRow>(
        "SELECT * FROM managed_restaurants ORDER BY updated_at DESC, name"
      )
    : await rows<RestaurantRow>(
        `SELECT r.* FROM managed_restaurants r
         JOIN restaurant_memberships m ON m.restaurant_id = r.id
         WHERE m.user_id = $1 AND m.role IN ('owner', 'admin', 'manager')
         ORDER BY r.updated_at DESC, r.name`,
        [userId]
      );
  return rowsFound.map(mapRestaurant);
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`${label} is required.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${label} must be between 1 and ${maxLength} characters.`);
  }
  return normalized;
}

function optionalText(value: unknown, label: string, maxLength: number): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > maxLength) {
    throw new Error(`${label} must be at most ${maxLength} characters.`);
  }
  return value.trim() || null;
}

function slugValue(value: unknown): string {
  const slug = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) {
    throw new Error("Use a restaurant URL with lowercase letters, numbers, and hyphens.");
  }
  return slug;
}

function nonNegativeInteger(value: unknown, label: string, max = 100_000_000): number {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > max) {
    throw new Error(`${label} must be a non-negative whole number.`);
  }
  return amount;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be true or false.`);
  return value;
}

/** Optional free text: null or "" clears it; anything other than a string is refused. */
function plainText(value: unknown, label: string, maxLength: number): string {
  if (value == null) return "";
  if (typeof value !== "string") throw new Error(`${label} must be text.`);
  const normalized = value.trim();
  if (normalized.length > maxLength) throw new Error(`${label} must be at most ${maxLength} characters.`);
  return normalized;
}

/** A week of opening hours, at most one entry per weekday. An empty list removes all hours. */
function openingHoursValue(value: unknown): OpeningHours[] {
  if (!Array.isArray(value) || value.length > 7) throw new Error("Opening hours are invalid.");
  const seen = new Set<number>();
  return value.map((entry) => {
    const day = (entry ?? {}) as Record<string, unknown>;
    const weekday = Number(day.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6 || seen.has(weekday)) {
      throw new Error("Each weekday may appear once in the opening hours.");
    }
    seen.add(weekday);
    const isClosed = booleanValue(day.isClosed, "Closed");
    if (isClosed) return { weekday, opensAt: null, closesAt: null, isClosed };
    if (!isValidClockTime(day.opensAt) || !isValidClockTime(day.closesAt)) {
      throw new Error(`Enter opening and closing times as HH:MM for ${WEEKDAY_NAMES[weekday]}.`);
    }
    return { weekday, opensAt: day.opensAt, closesAt: day.closesAt, isClosed };
  });
}

/**
 * Pass the transaction's client when calling inside one: borrowing a second pool
 * connection while holding a lock can exhaust the pool and deadlock under load.
 */
export async function getOpeningHours(restaurantId: string, client?: Queryable): Promise<OpeningHours[]> {
  const sql = `SELECT weekday, opens_at, closes_at, is_closed FROM restaurant_operating_hours
     WHERE restaurant_id = $1 ORDER BY weekday`;
  const found = client
    ? (await client.query<RestaurantRow>(sql, [restaurantId])).rows
    : await rows<RestaurantRow>(sql, [restaurantId]);
  return found.map((row) => ({
    weekday: Number(row.weekday),
    opensAt: nullableText(row.opens_at),
    closesAt: nullableText(row.closes_at),
    isClosed: Number(row.is_closed) === 1,
  }));
}

function stringList(value: unknown, label: string, maxItems = 30, maxLength = 100): string[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new Error(`${label} is invalid.`);
  }
  const normalized = value.map((item) => requiredText(item, label, maxLength));
  if (new Set(normalized.map((item) => item.toLowerCase())).size !== normalized.length) {
    throw new Error(`${label} cannot contain duplicates.`);
  }
  return normalized;
}

export async function createManagedRestaurant(userId: string, input: unknown): Promise<ManagedRestaurant> {
  if (!(await isRestaurantAdmin(userId))) {
    throw new Error("A restaurant administrator must approve your owner account first.");
  }
  const body = (input ?? {}) as Record<string, unknown>;
  const id = `rst_${randomUUID()}`;
  const name = requiredText(body.name, "Restaurant name", 120);
  const slug = slugValue(body.slug);
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 2000) : "";
  const address = typeof body.address === "string" ? body.address.trim().slice(0, 300) : "";
  const city = typeof body.city === "string" ? body.city.trim().slice(0, 100) : "";
  const state = typeof body.state === "string" ? body.state.trim().slice(0, 100) : "";
  const postalCode = typeof body.postalCode === "string" ? body.postalCode.trim().slice(0, 20) : "";
  const now = new Date().toISOString();
  const minimumOrderPaise =
    body.minimumOrderPaise === undefined ? 0 : nonNegativeInteger(body.minimumOrderPaise, "Minimum order");
  const deliveryFeePaise =
    body.deliveryFeePaise === undefined ? 0 : nonNegativeInteger(body.deliveryFeePaise, "Delivery fee");
  const taxRateBps =
    body.taxRateBps === undefined ? 0 : nonNegativeInteger(body.taxRateBps, "Tax rate", 10000);

  return transaction(async (client) => {
    const inserted = await client.query<RestaurantRow>(
      `INSERT INTO managed_restaurants
       (id, owner_user_id, slug, name, description, phone, email, address, city, state,
        postal_code, service_areas, delivery_enabled, takeaway_enabled, dine_in_enabled,
        minimum_order_paise, delivery_fee_paise, tax_rate_bps, tax_enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16, $17, $18, $19, $20, $20)
       RETURNING *`,
      [
        id,
        userId,
        slug,
        name,
        description,
        optionalText(body.phone, "Phone", 40),
        optionalText(body.email, "Email", 160)?.toLowerCase() ?? null,
        address,
        city,
        state,
        postalCode,
        JSON.stringify(stringList(body.serviceAreas, "Service area")),
        Number(body.deliveryEnabled === undefined ? false : booleanValue(body.deliveryEnabled, "Delivery")),
        Number(body.takeawayEnabled === undefined ? true : booleanValue(body.takeawayEnabled, "Takeaway")),
        Number(body.dineInEnabled === undefined ? true : booleanValue(body.dineInEnabled, "Dine-in")),
        minimumOrderPaise,
        deliveryFeePaise,
        taxRateBps,
        Number(body.taxEnabled === undefined ? false : booleanValue(body.taxEnabled, "Tax")),
        now,
      ]
    );
    await client.query(
      `INSERT INTO restaurant_memberships (restaurant_id, user_id, role, granted_at, granted_by)
       VALUES ($1, $2, 'owner', $3, $2)`,
      [id, userId, now]
    );
    await client.query(
      `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, created_at)
       VALUES ($1, $2, 'RESTAURANT_CREATED', $3, $4)`,
      [id, userId, id, now]
    );
    return mapRestaurant(inserted.rows[0]);
  });
}

export async function updateManagedRestaurant(
  userId: string,
  restaurantId: string,
  input: unknown
): Promise<ManagedRestaurant> {
  await assertCanManageRestaurant(userId, restaurantId);
  const body = (input ?? {}) as Record<string, unknown>;
  // Fields left out keep their stored value. The row is read under a lock in the same
  // transaction, so two partial saves (details form, ordering switch) cannot undo each other.
  return transaction(async (client) => {
    const locked = await client.query<RestaurantRow>(
      "SELECT * FROM managed_restaurants WHERE id = $1 FOR UPDATE",
      [restaurantId]
    );
    const current = locked.rows[0];
    if (!current) throw new Error("Restaurant not found.");

    const name = body.name === undefined ? text(current.name) : requiredText(body.name, "Restaurant name", 120);
    const slug = body.slug === undefined ? text(current.slug) : slugValue(body.slug);
    const description =
      body.description === undefined
        ? text(current.description)
        : typeof body.description === "string"
          ? body.description.trim().slice(0, 2000)
          : (() => { throw new Error("Description must be text."); })();
    const phone = body.phone === undefined ? nullableText(current.phone) : optionalText(body.phone, "Phone", 40);
    const email =
      body.email === undefined
        ? nullableText(current.email)
        : optionalText(body.email, "Email", 160)?.toLowerCase() ?? null;
    const address = body.address === undefined ? text(current.address) : plainText(body.address, "Address", 300);
    const city = body.city === undefined ? text(current.city) : plainText(body.city, "City", 100);
    const state = body.state === undefined ? text(current.state) : plainText(body.state, "State", 100);
    const postalCode = body.postalCode === undefined ? text(current.postal_code) : plainText(body.postalCode, "Postal code", 20);
    const serviceAreas = body.serviceAreas === undefined ? jsonArray(current.service_areas) : stringList(body.serviceAreas, "Service area");
    const deliveryEnabled = body.deliveryEnabled === undefined ? Number(current.delivery_enabled) === 1 : booleanValue(body.deliveryEnabled, "Delivery");
    const takeawayEnabled = body.takeawayEnabled === undefined ? Number(current.takeaway_enabled) === 1 : booleanValue(body.takeawayEnabled, "Takeaway");
    const dineInEnabled = body.dineInEnabled === undefined ? Number(current.dine_in_enabled) === 1 : booleanValue(body.dineInEnabled, "Dine-in");
    const minimumOrderPaise = body.minimumOrderPaise === undefined ? Number(current.minimum_order_paise) : nonNegativeInteger(body.minimumOrderPaise, "Minimum order");
    const deliveryFeePaise = body.deliveryFeePaise === undefined ? Number(current.delivery_fee_paise) : nonNegativeInteger(body.deliveryFeePaise, "Delivery fee");
    const taxRateBps = body.taxRateBps === undefined ? Number(current.tax_rate_bps) : nonNegativeInteger(body.taxRateBps, "Tax rate", 10000);
    const taxEnabled = body.taxEnabled === undefined ? Number(current.tax_enabled) === 1 : booleanValue(body.taxEnabled, "Tax");
    const acceptingOrders = body.acceptingOrders === undefined ? Number(current.accepting_orders) === 1 : booleanValue(body.acceptingOrders, "Accepting orders");
    const hours = body.hours === undefined ? null : openingHoursValue(body.hours);
    const now = new Date().toISOString();

    const updated = await client.query<RestaurantRow>(
      `UPDATE managed_restaurants SET
       slug = $2, name = $3, description = $4, phone = $5, email = $6, address = $7,
       city = $8, state = $9, postal_code = $10, service_areas = $11::jsonb,
       delivery_enabled = $12, takeaway_enabled = $13, dine_in_enabled = $14,
       minimum_order_paise = $15, delivery_fee_paise = $16, tax_rate_bps = $17,
       tax_enabled = $18, updated_at = $19, accepting_orders = $20
       WHERE id = $1 RETURNING *`,
      [
        restaurantId, slug, name, description, phone, email, address, city, state, postalCode,
        JSON.stringify(serviceAreas), Number(deliveryEnabled), Number(takeawayEnabled),
        Number(dineInEnabled), minimumOrderPaise, deliveryFeePaise, taxRateBps,
        Number(taxEnabled), now, Number(acceptingOrders),
      ]
    );
    if (hours) {
      // The week is replaced whole, so a half-applied edit can never leave mixed hours.
      await client.query("DELETE FROM restaurant_operating_hours WHERE restaurant_id = $1", [restaurantId]);
      if (hours.length) {
        await client.query(
          `INSERT INTO restaurant_operating_hours (restaurant_id, weekday, opens_at, closes_at, is_closed)
           SELECT $1, d.weekday, d.opens_at, d.closes_at, d.is_closed
           FROM jsonb_to_recordset($2::jsonb)
             AS d(weekday smallint, opens_at text, closes_at text, is_closed integer)`,
          [
            restaurantId,
            JSON.stringify(
              hours.map((day) => ({
                weekday: day.weekday,
                opens_at: day.opensAt,
                closes_at: day.closesAt,
                is_closed: Number(day.isClosed),
              }))
            ),
          ]
        );
      }
    }
    await client.query(
      `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, detail, created_at)
       VALUES ($1, $2, 'RESTAURANT_UPDATED', $1, $3::jsonb, $4)`,
      [restaurantId, userId, JSON.stringify({ fields: Object.keys(body).sort() }), now]
    );
    return mapRestaurant(updated.rows[0]);
  });
}

export async function changeRestaurantPublication(
  userId: string,
  restaurantId: string,
  publish: boolean
): Promise<ManagedRestaurant> {
  await assertCanManageRestaurant(userId, restaurantId);
  const now = new Date().toISOString();
  return transaction(async (client) => {
    const locked = await client.query("SELECT id FROM managed_restaurants WHERE id = $1 FOR UPDATE", [
      restaurantId,
    ]);
    if (!locked.rowCount) throw new Error("Restaurant not found.");
    if (publish) {
      const counts = await client.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM menu_items i
         JOIN menu_categories c ON c.id = i.category_id AND c.restaurant_id = i.restaurant_id
         WHERE i.restaurant_id = $1 AND i.published = 1 AND i.available = 1 AND c.visible = 1`,
        [restaurantId]
      );
      if (Number(counts.rows[0]?.count ?? 0) === 0) {
        throw new Error("Publish at least one available menu item before publishing the restaurant.");
      }
    }
    const updated = await client.query<RestaurantRow>(
      `UPDATE managed_restaurants
       SET status = $2, published_at = $3, updated_at = $4
       WHERE id = $1 RETURNING *`,
      [restaurantId, publish ? "published" : "draft", publish ? now : null, now]
    );
    if (!updated.rows[0]) throw new Error("Restaurant not found.");
    await client.query(
      `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, created_at)
       VALUES ($1, $2, $3, $1, $4)`,
      [restaurantId, userId, publish ? "RESTAURANT_PUBLISHED" : "RESTAURANT_UNPUBLISHED", now]
    );
    return mapRestaurant(updated.rows[0]);
  });
}

export async function listPublishedRestaurants(): Promise<ManagedRestaurant[]> {
  const found = await rows<RestaurantRow>(
    `SELECT * FROM managed_restaurants
     WHERE status = 'published'
     ORDER BY name`
  );
  return found.map(mapRestaurant);
}

export async function getPublishedRestaurantBySlug(slug: string): Promise<ManagedRestaurant | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || slug.length > 80) return null;
  const restaurant = await one<RestaurantRow>(
    "SELECT * FROM managed_restaurants WHERE slug = $1 AND status = 'published'",
    [slug]
  );
  return restaurant ? mapRestaurant(restaurant) : null;
}

function parseVariant(row: Record<string, unknown>): MenuVariant {
  return {
    id: text(row.id),
    name: text(row.name),
    priceDeltaPaise: Number(row.price_delta_paise),
    available: Number(row.available) === 1,
  };
}

function parseAddon(row: Record<string, unknown>): MenuAddon {
  return {
    id: text(row.id),
    name: text(row.name),
    pricePaise: Number(row.price_paise),
    available: Number(row.available) === 1,
  };
}

export async function getManagedMenu(
  userId: string,
  restaurantId: string,
  publishedOnly = false
): Promise<ManagedMenuCategory[]> {
  if (publishedOnly) {
    const restaurant = await one(
      "SELECT 1 FROM managed_restaurants WHERE id = $1 AND status = 'published'",
      [restaurantId]
    );
    if (!restaurant) return [];
  } else {
    await assertCanManageRestaurant(userId, restaurantId);
  }

  const categories = await rows<RestaurantRow>(
    `SELECT * FROM menu_categories WHERE restaurant_id = $1 ${publishedOnly ? "AND visible = 1" : ""}
     ORDER BY display_order, name`,
    [restaurantId]
  );
  const itemRows = await rows<RestaurantRow>(
    `SELECT * FROM menu_items
     WHERE restaurant_id = $1 ${publishedOnly ? "AND published = 1 AND available = 1" : ""}
     ORDER BY display_order, name`,
    [restaurantId]
  );
  const itemIds = itemRows.map((item) => text(item.id));
  const variants = itemIds.length
    ? await rows<RestaurantRow>(
        `SELECT * FROM menu_item_variants
         WHERE restaurant_id = $1 AND item_id = ANY($2::text[])
           ${publishedOnly ? "AND available = 1" : ""}
         ORDER BY display_order, name`,
        [restaurantId, itemIds]
      )
    : [];
  const addons = itemIds.length
    ? await rows<RestaurantRow>(
        `SELECT * FROM menu_item_addons
         WHERE restaurant_id = $1 AND item_id = ANY($2::text[])
           ${publishedOnly ? "AND available = 1" : ""}
         ORDER BY display_order, name`,
        [restaurantId, itemIds]
      )
    : [];

  const itemsByCategory = new Map<string, ManagedMenuItem[]>();
  for (const row of itemRows) {
    const id = text(row.id);
    const categoryId = text(row.category_id);
    const item: ManagedMenuItem = {
      id,
      categoryId,
      name: text(row.name),
      description: text(row.description),
      pricePaise: Number(row.price_paise),
      discountedPricePaise: row.discounted_price_paise == null ? null : Number(row.discounted_price_paise),
      dietaryTags: jsonArray(row.dietary_tags),
      allergens: jsonArray(row.allergens),
      portionSize: text(row.portion_size),
      prepMinutes: row.prep_minutes == null ? null : Number(row.prep_minutes),
      spicyLevel: row.spicy_level == null ? null : Number(row.spicy_level),
      available: Number(row.available) === 1,
      published: Number(row.published) === 1,
      featured: Number(row.featured) === 1,
      imageAssetId: nullableText(row.image_asset_id),
      displayOrder: Number(row.display_order),
      sourceImportId: nullableText(row.source_import_id),
      revision: Number(row.revision),
      variants: variants.filter((variant) => text(variant.item_id) === id).map(parseVariant),
      addons: addons.filter((addon) => text(addon.item_id) === id).map(parseAddon),
    };
    const items = itemsByCategory.get(categoryId) ?? [];
    items.push(item);
    itemsByCategory.set(categoryId, items);
  }

  return categories.map((category) => ({
    id: text(category.id),
    name: text(category.name),
    displayOrder: Number(category.display_order),
    visible: Number(category.visible) === 1,
    items: itemsByCategory.get(text(category.id)) ?? [],
  }));
}

export async function createMenuCategory(
  userId: string,
  restaurantId: string,
  input: unknown
): Promise<ManagedMenuCategory> {
  await assertCanManageRestaurant(userId, restaurantId);
  const body = (input ?? {}) as Record<string, unknown>;
  const name = requiredText(body.name, "Category name", 80);
  const displayOrder = nonNegativeInteger(body.displayOrder ?? 0, "Display order", 100000);
  const id = `cat_${randomUUID()}`;
  const now = new Date().toISOString();
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO menu_categories (id, restaurant_id, name, display_order, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [id, restaurantId, name, displayOrder, now]
    );
    await client.query(
      `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, created_at)
       VALUES ($1, $2, 'MENU_CATEGORY_CREATED', $3, $4)`,
      [restaurantId, userId, id, now]
    );
  });
  return { id, name, displayOrder, visible: true, items: [] };
}

export async function updateMenuCategory(
  userId: string,
  restaurantId: string,
  categoryId: string,
  input: unknown
): Promise<void> {
  await assertCanManageRestaurant(userId, restaurantId);
  const body = (input ?? {}) as Record<string, unknown>;
  const current = await one<RestaurantRow>(
    "SELECT * FROM menu_categories WHERE id = $1 AND restaurant_id = $2",
    [categoryId, restaurantId]
  );
  if (!current) throw new Error("Category not found in this restaurant.");
  const name = body.name === undefined ? text(current.name) : requiredText(body.name, "Category name", 80);
  const displayOrder =
    body.displayOrder === undefined
      ? Number(current.display_order)
      : nonNegativeInteger(body.displayOrder, "Display order", 100000);
  const visible =
    body.visible === undefined ? Number(current.visible) === 1 : booleanValue(body.visible, "Visibility");
  const updatedAt = new Date().toISOString();
  await transaction(async (client) => {
    await client.query(
      `UPDATE menu_categories SET name = $3, display_order = $4, visible = $5, updated_at = $6
       WHERE id = $1 AND restaurant_id = $2`,
      [categoryId, restaurantId, name, displayOrder, Number(visible), updatedAt]
    );
    await client.query(
      `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, detail, created_at)
       VALUES ($1, $2, 'MENU_CATEGORY_UPDATED', $3, $4::jsonb, $5)`,
      [restaurantId, userId, categoryId, JSON.stringify({ name, displayOrder, visible }), updatedAt]
    );
  });
}

export async function deleteMenuCategory(
  userId: string,
  restaurantId: string,
  categoryId: string
): Promise<void> {
  await assertCanManageRestaurant(userId, restaurantId);
  const items = await one<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM menu_items WHERE category_id = $1 AND restaurant_id = $2",
    [categoryId, restaurantId]
  );
  if (Number(items?.count ?? 0) > 0) {
    throw new Error("Move or delete this category's dishes before deleting the category.");
  }
  await transaction(async (client) => {
    const deleted = await client.query(
      "DELETE FROM menu_categories WHERE id = $1 AND restaurant_id = $2",
      [categoryId, restaurantId]
    );
    if (!deleted.rowCount) throw new Error("Category not found in this restaurant.");
    await client.query(
      `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, created_at)
       VALUES ($1, $2, 'MENU_CATEGORY_DELETED', $3, $4)`,
      [restaurantId, userId, categoryId, new Date().toISOString()]
    );
  });
}

export async function saveMenuItem(
  userId: string,
  restaurantId: string,
  input: unknown
): Promise<ManagedMenuItem> {
  await assertCanManageRestaurant(userId, restaurantId);
  const body = (input ?? {}) as Record<string, unknown>;
  const categoryId = requiredText(body.categoryId, "Category", 100);
  const category = await one(
    "SELECT 1 FROM menu_categories WHERE id = $1 AND restaurant_id = $2",
    [categoryId, restaurantId]
  );
  if (!category) throw new Error("Choose a category from this restaurant.");

  const name = requiredText(body.name, "Dish name", 120);
  const description = typeof body.description === "string" ? body.description.trim().slice(0, 1000) : "";
  const pricePaise = nonNegativeInteger(body.pricePaise, "Price");
  const discountedPricePaise =
    body.discountedPricePaise == null || body.discountedPricePaise === ""
      ? null
      : nonNegativeInteger(body.discountedPricePaise, "Discounted price");
  if (discountedPricePaise !== null && discountedPricePaise > pricePaise) {
    throw new Error("Discounted price cannot be more than the regular price.");
  }
  const dietaryTags = stringList(body.dietaryTags, "Dietary tags", 10, 40);
  const allergens = stringList(body.allergens, "Allergens", 30, 80);
  const portionSize = typeof body.portionSize === "string" ? body.portionSize.trim().slice(0, 80) : "";
  const prepMinutes = body.prepMinutes == null || body.prepMinutes === "" ? null : nonNegativeInteger(body.prepMinutes, "Preparation time", 1440);
  const spicyLevel = body.spicyLevel == null || body.spicyLevel === "" ? null : nonNegativeInteger(body.spicyLevel, "Spice level", 5);
  const displayOrder = nonNegativeInteger(body.displayOrder ?? 0, "Display order", 100000);
  const available = body.available === undefined ? true : booleanValue(body.available, "Availability");
  const published = body.published === undefined ? false : booleanValue(body.published, "Publication");
  const featured = body.featured === undefined ? false : booleanValue(body.featured, "Featured status");
  const imageAssetId = optionalText(body.imageAssetId, "Image", 100);
  if (imageAssetId) {
    const asset = await one(
      `SELECT 1 FROM restaurant_assets
       WHERE id = $1 AND restaurant_id = $2 AND kind = 'menu_item_image'`,
      [imageAssetId, restaurantId]
    );
    if (!asset) throw new Error("Choose an image uploaded to this restaurant.");
  }
  const itemId = typeof body.id === "string" && body.id.trim() ? body.id.trim() : `itm_${randomUUID()}`;
  // Required on update: without it a stale tab would silently overwrite a newer save.
  const expectedRevision = body.id ? nonNegativeInteger(body.revision, "Revision") : null;
  const sourceImportId = optionalText(body.sourceImportId, "Import", 100);
  const sourceImportItemId = optionalText(body.sourceImportItemId, "Import item", 100);
  const now = new Date().toISOString();
  const variantsInput = Array.isArray(body.variants) ? body.variants : [];
  const addonsInput = Array.isArray(body.addons) ? body.addons : [];
  if (variantsInput.length > 20 || addonsInput.length > 30) throw new Error("Too many variants or add-ons.");

  const variants: MenuVariant[] = variantsInput.map((value) => {
    const variant = (value ?? {}) as Record<string, unknown>;
    return {
      id: variant.id === undefined ? `var_${randomUUID()}` : requiredText(variant.id, "Variant ID", 100),
      name: requiredText(variant.name, "Variant name", 80),
      priceDeltaPaise: nonNegativeInteger(variant.priceDeltaPaise, "Variant price"),
      available: variant.available !== false,
    };
  });
  const addons: MenuAddon[] = addonsInput.map((value) => {
    const addon = (value ?? {}) as Record<string, unknown>;
    return {
      id: addon.id === undefined ? `add_${randomUUID()}` : requiredText(addon.id, "Add-on ID", 100),
      name: requiredText(addon.name, "Add-on name", 80),
      pricePaise: nonNegativeInteger(addon.pricePaise, "Add-on price"),
      available: addon.available !== false,
    };
  });

  return transaction(async (client) => {
    if (body.id) {
      const existing = await client.query<{ revision: number }>(
        "SELECT revision FROM menu_items WHERE id = $1 AND restaurant_id = $2 FOR UPDATE",
        [itemId, restaurantId]
      );
      if (!existing.rowCount) throw new Error("Dish not found in this restaurant.");
      if (Number(existing.rows[0].revision) !== expectedRevision) throw new Error(MENU_ITEM_CONFLICT);
    }
    const saved = await client.query<RestaurantRow>(
      `INSERT INTO menu_items
       (id, restaurant_id, category_id, name, description, price_paise, discounted_price_paise,
        dietary_tags, allergens, portion_size, prep_minutes, spicy_level, available, published,
        featured, image_asset_id, display_order, source_import_id, source_import_item_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $20)
       ON CONFLICT (id) DO UPDATE SET category_id = excluded.category_id, name = excluded.name,
        description = excluded.description, price_paise = excluded.price_paise,
        discounted_price_paise = excluded.discounted_price_paise, dietary_tags = excluded.dietary_tags,
        allergens = excluded.allergens, portion_size = excluded.portion_size,
        prep_minutes = excluded.prep_minutes, spicy_level = excluded.spicy_level,
        available = excluded.available, published = excluded.published, featured = excluded.featured,
        image_asset_id = excluded.image_asset_id, display_order = excluded.display_order,
        updated_at = excluded.updated_at, revision = menu_items.revision + 1
       RETURNING *`,
      [
        itemId, restaurantId, categoryId, name, description, pricePaise, discountedPricePaise,
        dietaryTags, allergens, portionSize, prepMinutes, spicyLevel, Number(available),
        Number(published), Number(featured), imageAssetId, displayOrder, sourceImportId, sourceImportItemId, now,
      ]
    );
    await client.query("DELETE FROM menu_item_variants WHERE item_id = $1 AND restaurant_id = $2", [itemId, restaurantId]);
    await client.query("DELETE FROM menu_item_addons WHERE item_id = $1 AND restaurant_id = $2", [itemId, restaurantId]);
    for (const [index, variant] of variants.entries()) {
      await client.query(
        `INSERT INTO menu_item_variants
         (id, restaurant_id, item_id, name, price_delta_paise, display_order, available)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [variant.id, restaurantId, itemId, variant.name, variant.priceDeltaPaise, index, Number(variant.available)]
      );
    }
    for (const [index, addon] of addons.entries()) {
      await client.query(
        `INSERT INTO menu_item_addons
         (id, restaurant_id, item_id, name, price_paise, display_order, available)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [addon.id, restaurantId, itemId, addon.name, addon.pricePaise, index, Number(addon.available)]
      );
    }
    await client.query(
      `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, detail, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [restaurantId, userId, body.id ? "MENU_ITEM_UPDATED" : "MENU_ITEM_CREATED", itemId, JSON.stringify({ name, categoryId }), now]
    );
    const row = saved.rows[0];
    return {
      id: itemId, categoryId, name, description, pricePaise, discountedPricePaise, dietaryTags,
      allergens, portionSize, prepMinutes, spicyLevel, available, published, featured,
      imageAssetId: nullableText(row.image_asset_id), displayOrder, sourceImportId,
      revision: Number(row.revision), variants, addons,
    };
  });
}

export async function setMenuItemAvailability(
  userId: string,
  restaurantId: string,
  input: unknown
): Promise<{ id: string; available: boolean; revision: number }> {
  await assertCanManageRestaurant(userId, restaurantId);
  const body = (input ?? {}) as Record<string, unknown>;
  const itemId = requiredText(body.id, "Dish", 100);
  const available = booleanValue(body.available, "Availability");
  const expectedRevision = nonNegativeInteger(body.revision, "Revision");
  const now = new Date().toISOString();
  return transaction(async (client) => {
    // One statement decides: a stale revision updates nothing instead of racing a read.
    const updated = await client.query<{ revision: number }>(
      `UPDATE menu_items SET available = $3, revision = revision + 1, updated_at = $5
       WHERE id = $1 AND restaurant_id = $2 AND revision = $4
       RETURNING revision`,
      [itemId, restaurantId, Number(available), expectedRevision, now]
    );
    if (!updated.rowCount) {
      const exists = await client.query("SELECT 1 FROM menu_items WHERE id = $1 AND restaurant_id = $2", [
        itemId,
        restaurantId,
      ]);
      throw new Error(exists.rowCount ? MENU_ITEM_CONFLICT : "Dish not found in this restaurant.");
    }
    await client.query(
      `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, detail, created_at)
       VALUES ($1, $2, 'MENU_ITEM_AVAILABILITY', $3, $4::jsonb, $5)`,
      [restaurantId, userId, itemId, JSON.stringify({ available }), now]
    );
    return { id: itemId, available, revision: Number(updated.rows[0].revision) };
  });
}

export async function deleteMenuItem(
  userId: string,
  restaurantId: string,
  itemId: string
): Promise<void> {
  await assertCanManageRestaurant(userId, restaurantId);
  await transaction(async (client) => {
    const deleted = await client.query(
      "DELETE FROM menu_items WHERE id = $1 AND restaurant_id = $2",
      [itemId, restaurantId]
    );
    if (!deleted.rowCount) throw new Error("Dish not found in this restaurant.");
    await client.query(
      `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, created_at)
       VALUES ($1, $2, 'MENU_ITEM_DELETED', $3, $4)`,
      [restaurantId, userId, itemId, new Date().toISOString()]
    );
  });
}

export async function listMenuImportJobs(
  userId: string,
  restaurantId: string
): Promise<MenuImportJob[]> {
  await assertCanManageRestaurant(userId, restaurantId);
  const found = await rows<RestaurantRow>(
    `SELECT j.*, a.file_name FROM menu_import_jobs j
     JOIN restaurant_assets a ON a.id = j.source_asset_id AND a.restaurant_id = j.restaurant_id
     WHERE j.restaurant_id = $1 ORDER BY j.created_at DESC LIMIT 50`,
    [restaurantId]
  );
  return found.map((row) => {
    let extractedItems: ExtractedMenuItem[] = [];
    try {
      const value = typeof row.extracted_items === "string" ? JSON.parse(row.extracted_items) : row.extracted_items;
      if (Array.isArray(value)) extractedItems = value as ExtractedMenuItem[];
    } catch {
      extractedItems = [];
    }
    return {
      id: text(row.id),
      restaurantId: text(row.restaurant_id),
      sourceAssetId: text(row.source_asset_id),
      fileName: text(row.file_name),
      status: text(row.status) as MenuImportJob["status"],
      extractedItems,
      errorMessage: nullableText(row.error_message),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    };
  });
}

export async function createRestaurantAsset(input: {
  userId: string;
  restaurantId: string;
  objectKey: string;
  kind: "menu_document" | "menu_item_image";
  fileName: string;
  mimeType: string;
  byteSize: number;
}): Promise<{ id: string; importJobId?: string }> {
  await assertCanManageRestaurant(input.userId, input.restaurantId);
  const assetId = `ast_${randomUUID()}`;
  const importJobId = input.kind === "menu_document" ? `imp_${randomUUID()}` : undefined;
  const now = new Date().toISOString();
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO restaurant_assets
       (id, restaurant_id, uploaded_by, object_key, kind, file_name, mime_type, byte_size, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        assetId,
        input.restaurantId,
        input.userId,
        input.objectKey,
        input.kind,
        input.fileName,
        input.mimeType,
        input.byteSize,
        now,
      ]
    );
    if (importJobId) {
      await client.query(
        `INSERT INTO menu_import_jobs
         (id, restaurant_id, source_asset_id, requested_by, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'uploaded', $5, $5)`,
        [importJobId, input.restaurantId, assetId, input.userId, now]
      );
    }
    await client.query(
      `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, detail, created_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [
        input.restaurantId,
        input.userId,
        input.kind === "menu_document" ? "MENU_DOCUMENT_UPLOADED" : "MENU_ITEM_IMAGE_UPLOADED",
        assetId,
        JSON.stringify({ mimeType: input.mimeType, byteSize: input.byteSize }),
        now,
      ]
    );
  });
  return { id: assetId, importJobId };
}

export async function getMenuDocumentForOwner(
  userId: string,
  restaurantId: string,
  importId: string
): Promise<{ job: MenuImportJob; objectKey: string; mimeType: string } | null> {
  await assertCanManageRestaurant(userId, restaurantId);
  const row = await one<RestaurantRow>(
    `SELECT j.*, a.file_name, a.object_key, a.mime_type
     FROM menu_import_jobs j
     JOIN restaurant_assets a ON a.id = j.source_asset_id AND a.restaurant_id = j.restaurant_id
     WHERE j.id = $1 AND j.restaurant_id = $2`,
    [importId, restaurantId]
  );
  if (!row) return null;
  let extractedItems: ExtractedMenuItem[] = [];
  try {
    const value = typeof row.extracted_items === "string" ? JSON.parse(row.extracted_items) : row.extracted_items;
    if (Array.isArray(value)) extractedItems = value as ExtractedMenuItem[];
  } catch {
    extractedItems = [];
  }
  return {
    job: {
      id: text(row.id),
      restaurantId: text(row.restaurant_id),
      sourceAssetId: text(row.source_asset_id),
      fileName: text(row.file_name),
      status: text(row.status) as MenuImportJob["status"],
      extractedItems,
      errorMessage: nullableText(row.error_message),
      createdAt: text(row.created_at),
      updatedAt: text(row.updated_at),
    },
    objectKey: text(row.object_key),
    mimeType: text(row.mime_type),
  };
}

export async function claimMenuExtraction(
  userId: string,
  restaurantId: string,
  importId: string
): Promise<boolean> {
  await assertCanManageRestaurant(userId, restaurantId);
  const now = new Date();
  const updatedAt = now.toISOString();
  const staleBefore = new Date(now.getTime() - 5 * 60_000).toISOString();
  const claimed = await one<{ id: string }>(
    `UPDATE menu_import_jobs
     SET status = 'processing', error_message = NULL, updated_at = $4
     WHERE id = $1 AND restaurant_id = $2
       AND (
         status IN ('uploaded', 'failed')
         OR (status = 'processing' AND updated_at <= $3)
       )
     RETURNING id`,
    [importId, restaurantId, staleBefore, updatedAt]
  );
  return Boolean(claimed);
}

export async function saveMenuExtraction(
  userId: string,
  restaurantId: string,
  importId: string,
  extractedItems: ExtractedMenuItem[]
): Promise<void> {
  await assertCanManageRestaurant(userId, restaurantId);
  await run(
    `UPDATE menu_import_jobs SET status = 'review', extracted_items = $3::jsonb,
     error_message = NULL, updated_at = $4
     WHERE id = $1 AND restaurant_id = $2`,
    [importId, restaurantId, JSON.stringify(extractedItems), new Date().toISOString()]
  );
}

export async function failMenuExtraction(
  userId: string,
  restaurantId: string,
  importId: string,
  message: string
): Promise<void> {
  await assertCanManageRestaurant(userId, restaurantId);
  await run(
    `UPDATE menu_import_jobs SET status = 'failed', error_message = $3, updated_at = $4
     WHERE id = $1 AND restaurant_id = $2`,
    [importId, restaurantId, message.slice(0, 300), new Date().toISOString()]
  );
}

export async function updateMenuImportDraft(
  userId: string,
  restaurantId: string,
  importId: string,
  values: unknown
): Promise<ExtractedMenuItem[]> {
  await assertCanManageRestaurant(userId, restaurantId);
  if (!Array.isArray(values) || values.length > 250) {
    throw new Error("The reviewed menu is invalid.");
  }
  const job = await one<RestaurantRow>(
    "SELECT extracted_items, status FROM menu_import_jobs WHERE id = $1 AND restaurant_id = $2",
    [importId, restaurantId]
  );
  if (!job || text(job.status) !== "review") throw new Error("This menu is not ready for review.");
  const existing =
    Array.isArray(job.extracted_items)
      ? (job.extracted_items as ExtractedMenuItem[])
      : typeof job.extracted_items === "string"
        ? (JSON.parse(job.extracted_items) as ExtractedMenuItem[])
        : [];
  const known = new Map(existing.map((item) => [item.id, item]));
  const drafts: ExtractedMenuItem[] = values.map((value) => {
    const row = (value ?? {}) as Record<string, unknown>;
    const id = requiredText(row.id, "Draft item", 80);
    if (!known.has(id)) throw new Error("A reviewed row does not belong to this menu import.");
    const variantsInput = Array.isArray(row.variants) ? row.variants.slice(0, 20) : [];
    return {
      id,
      categoryName: typeof row.categoryName === "string" ? row.categoryName.trim().slice(0, 80) : "",
      name: typeof row.name === "string" ? row.name.trim().slice(0, 120) : "",
      description: typeof row.description === "string" ? row.description.trim().slice(0, 1000) : "",
      pricePaise:
        row.pricePaise == null || row.pricePaise === ""
          ? null
          : nonNegativeInteger(row.pricePaise, "Price"),
      dietaryTags: stringList(row.dietaryTags, "Dietary tags", 10, 40),
      allergens: stringList(row.allergens, "Allergens", 30, 80),
      portionSize: typeof row.portionSize === "string" ? row.portionSize.trim().slice(0, 80) : "",
      variants: variantsInput.map((rawVariant) => {
        const variant = (rawVariant ?? {}) as Record<string, unknown>;
        return {
          name: typeof variant.name === "string" ? variant.name.trim().slice(0, 80) : "",
          pricePaise:
            variant.pricePaise == null || variant.pricePaise === ""
              ? null
              : nonNegativeInteger(variant.pricePaise, "Variant price"),
        };
      }),
      sourcePage: nonNegativeInteger(row.sourcePage ?? 1, "Source page", 10000) || 1,
      sourceText: typeof row.sourceText === "string" ? row.sourceText.trim().slice(0, 500) : "",
      confidence:
        typeof row.confidence === "number" && Number.isFinite(row.confidence)
          ? Math.max(0, Math.min(1, row.confidence))
          : null,
      warnings: Array.isArray(row.warnings)
        ? row.warnings.filter((warning): warning is string => typeof warning === "string").map((warning) => warning.slice(0, 200)).slice(0, 10)
        : known.get(id)?.warnings ?? [],
    };
  });
  await run(
    `UPDATE menu_import_jobs SET extracted_items = $3::jsonb, updated_at = $4
     WHERE id = $1 AND restaurant_id = $2 AND status = 'review'`,
    [importId, restaurantId, JSON.stringify(drafts), new Date().toISOString()]
  );
  return drafts;
}

function validateReviewedItem(value: unknown): ImportedReviewItem {
  const item = (value ?? {}) as Record<string, unknown>;
  const name = requiredText(item.name, "Dish name", 120);
  const categoryName = requiredText(item.categoryName, "Category", 80);
  const pricePaise =
    item.pricePaise == null || item.pricePaise === ""
      ? null
      : nonNegativeInteger(item.pricePaise, "Price");
  if (pricePaise === null) throw new Error(`Enter a price for ${name} before importing it.`);
  const variantValues = Array.isArray(item.variants) ? item.variants.slice(0, 20) : [];
  const variants = variantValues.map((value) => {
    const variant = (value ?? {}) as Record<string, unknown>;
    return {
      name: requiredText(variant.name, "Variant name", 80),
      pricePaise:
        variant.pricePaise == null || variant.pricePaise === ""
          ? null
          : nonNegativeInteger(variant.pricePaise, "Variant price"),
    };
  });
  if (variants.some((variant) => variant.pricePaise === null)) {
    throw new Error(`Enter a price for every portion of ${name} before importing it.`);
  }
  return {
    id: requiredText(item.id, "Draft item", 80),
    categoryName,
    name,
    description: typeof item.description === "string" ? item.description.trim().slice(0, 1000) : "",
    pricePaise,
    dietaryTags: stringList(item.dietaryTags, "Dietary tags", 10, 40),
    allergens: stringList(item.allergens, "Allergens", 30, 80),
    portionSize: typeof item.portionSize === "string" ? item.portionSize.trim().slice(0, 80) : "",
    variants,
    sourcePage: nonNegativeInteger(item.sourcePage ?? 1, "Source page", 10000),
    sourceText: typeof item.sourceText === "string" ? item.sourceText.trim().slice(0, 500) : "",
    confidence:
      typeof item.confidence === "number" && Number.isFinite(item.confidence)
        ? Math.max(0, Math.min(1, item.confidence))
        : null,
    warnings: Array.isArray(item.warnings)
      ? item.warnings.filter((warning): warning is string => typeof warning === "string").map((warning) => warning.slice(0, 200)).slice(0, 10)
      : [],
  };
}

export async function importReviewedMenuItems(
  userId: string,
  restaurantId: string,
  importId: string,
  values: unknown
): Promise<{ imported: number; itemIds: string[]; alreadyImported: boolean }> {
  await assertCanManageRestaurant(userId, restaurantId);
  if (!Array.isArray(values) || values.length === 0 || values.length > 250) {
    throw new Error("Select at least one menu item to import.");
  }
  const reviewed = values.map(validateReviewedItem);
  if (new Set(reviewed.map((item) => item.id)).size !== reviewed.length) {
    throw new Error("The selected menu contains duplicate draft IDs.");
  }
  const now = new Date().toISOString();

  return transaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`menu-import:${restaurantId}`]);
    const jobResult = await client.query<RestaurantRow>(
      "SELECT * FROM menu_import_jobs WHERE id = $1 AND restaurant_id = $2 FOR UPDATE",
      [importId, restaurantId]
    );
    const job = jobResult.rows[0];
    if (!job) throw new Error("Menu import not found.");
    const extracted = Array.isArray(job.extracted_items)
      ? (job.extracted_items as ExtractedMenuItem[])
      : typeof job.extracted_items === "string"
        ? (JSON.parse(job.extracted_items) as ExtractedMenuItem[])
        : [];
    if (text(job.status) !== "review" && text(job.status) !== "imported") {
      throw new Error("Review the extracted menu before importing items.");
    }
    const validDraftIds = new Set(extracted.map((item) => item.id));
    if (reviewed.some((item) => !validDraftIds.has(item.id))) {
      throw new Error("A selected row does not belong to this menu import.");
    }

    const existing = await client.query<{ id: string; source_import_item_id: string }>(
      `SELECT id, source_import_item_id FROM menu_items
       WHERE source_import_id = $1 AND restaurant_id = $2`,
      [importId, restaurantId]
    );
    const importedIds = new Set(existing.rows.map((row) => row.source_import_item_id));
    if (reviewed.every((item) => importedIds.has(item.id))) {
      return { imported: 0, itemIds: existing.rows.map((row) => row.id), alreadyImported: true };
    }

    const insertedIds: string[] = [];
    for (const item of reviewed) {
      if (importedIds.has(item.id)) continue;

      const categoryResult = await client.query<{ id: string }>(
        `SELECT id FROM menu_categories
         WHERE restaurant_id = $1 AND lower(name) = lower($2)`,
        [restaurantId, item.categoryName]
      );
      const categoryId =
        categoryResult.rows[0]?.id ??
        (
          await client.query<{ id: string }>(
            `INSERT INTO menu_categories
             (id, restaurant_id, name, display_order, created_at, updated_at)
             VALUES ($1, $2, $3, (SELECT COALESCE(MAX(display_order), -1) + 1
               FROM menu_categories WHERE restaurant_id = $2), $4, $4)
             RETURNING id`,
            [`cat_${randomUUID()}`, restaurantId, item.categoryName, now]
          )
        ).rows[0].id;

      const prices = item.variants.length
        ? item.variants.map((variant) => variant.pricePaise!)
        : [item.pricePaise!];
      const basePrice = Math.min(...prices);
      const itemId = `itm_${createHash("sha256")
        .update(`${importId}:${item.id}`)
        .digest("hex")
        .slice(0, 32)}`;
      await client.query(
        `INSERT INTO menu_items
         (id, restaurant_id, category_id, name, description, price_paise, dietary_tags,
          allergens, portion_size, available, published, display_order, source_import_id,
          source_import_item_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 1, 0,
          (SELECT COALESCE(MAX(display_order), -1) + 1 FROM menu_items WHERE category_id = $3),
          $10, $11, $12, $12)`,
        [
          itemId, restaurantId, categoryId, item.name, item.description, basePrice,
          item.dietaryTags, item.allergens, item.portionSize, importId, item.id, now,
        ]
      );
      for (const [index, variant] of item.variants.entries()) {
        await client.query(
          `INSERT INTO menu_item_variants
           (id, restaurant_id, item_id, name, price_delta_paise, display_order, available)
           VALUES ($1, $2, $3, $4, $5, $6, 1)`,
          [
            `var_${createHash("sha256")
              .update(`${importId}:${item.id}:${variant.name}`)
              .digest("hex")
              .slice(0, 32)}`,
            restaurantId,
            itemId,
            variant.name,
            variant.pricePaise! - basePrice,
            index,
          ]
        );
      }
      insertedIds.push(itemId);
    }

    const allImported = extracted.every(
      (item) => importedIds.has(item.id) || reviewed.some((selected) => selected.id === item.id)
    );
    await client.query(
      `UPDATE menu_import_jobs SET status = $3, extracted_items = $4::jsonb,
       imported_at = CASE WHEN $3 = 'imported' THEN $5 ELSE imported_at END, updated_at = $5
       WHERE id = $1 AND restaurant_id = $2`,
      [
        importId,
        restaurantId,
        allImported ? "imported" : "review",
        JSON.stringify(extracted.map((item) => reviewed.find((chosen) => chosen.id === item.id) ?? item)),
        now,
      ]
    );
    await client.query(
      `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, detail, created_at)
       VALUES ($1, $2, 'MENU_DRAFT_IMPORTED', $3, $4::jsonb, $5)`,
      [restaurantId, userId, importId, JSON.stringify({ itemCount: insertedIds.length }), now]
    );
    return { imported: insertedIds.length, itemIds: insertedIds, alreadyImported: false };
  });
}
