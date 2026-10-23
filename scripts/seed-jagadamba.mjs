/**
 * Loads Jagadamba Maratha Khanawali and its menu into the managed-restaurant tables.
 *
 *   node --env-file=.env.local scripts/seed-jagadamba.mjs --owner-email=you@example.com [--publish]
 *
 * Safe to run again: the restaurant is matched by slug and dishes by name, so a rerun only
 * adds what is missing and never overwrites prices or details the owner has since edited.
 * The owner must already have an account. Online ordering stays off; the owner switches it
 * on from /owner. --publish makes the restaurant visible to customers.
 * Pass --url=... to target a different database (use the DIRECT connection string).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const MENU_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "jagadamba-menu.json");
const DIETARY_TAGS = new Set(["vegetarian", "non-vegetarian", "vegan", "contains-egg"]);

function text(value, label, max) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new Error(`${label} must be 1-${max} characters.`);
  }
  return value.trim();
}

function rupeesToPaise(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 100_000) {
    throw new Error(`${label} must be a whole number of rupees between 1 and 100000.`);
  }
  return value * 100;
}

/** Validates the menu file and converts it to paise, so a typo fails before any write. */
export function parseSeedMenu(raw) {
  const restaurant = raw?.restaurant ?? {};
  const slug = text(restaurant.slug, "Slug", 80);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("Slug must be lowercase words joined by hyphens.");
  const seenItems = new Set();
  const categories = (Array.isArray(raw?.categories) ? raw.categories : []).map((category) => ({
    name: text(category.name, "Category name", 80),
    items: (Array.isArray(category.items) ? category.items : []).map((item) => {
      const name = text(item.name, "Dish name", 120);
      if (seenItems.has(name.toLowerCase())) throw new Error(`"${name}" is listed twice.`);
      seenItems.add(name.toLowerCase());
      const dietaryTags = Array.isArray(item.dietary) ? item.dietary : [];
      for (const tag of dietaryTags) {
        if (!DIETARY_TAGS.has(tag)) throw new Error(`"${name}" has an unknown dietary tag "${tag}".`);
      }
      const variants = Array.isArray(item.variants)
        ? item.variants.map(([label, rupees]) => ({
            name: text(label, `${name} portion`, 80),
            pricePaise: rupeesToPaise(rupees, `${name} ${label}`),
          }))
        : [];
      if (variants.length === 1) throw new Error(`"${name}" needs two or more portions, or a single price.`);
      if (variants.length === 0 && item.rupees === undefined) throw new Error(`"${name}" has no price.`);
      // The cheapest portion is the base price; the others are stored as what they add to it.
      const basePaise = variants.length ? variants[0].pricePaise : rupeesToPaise(item.rupees, name);
      if (variants.some((variant) => variant.pricePaise < basePaise)) {
        throw new Error(`"${name}" must list its cheapest portion first.`);
      }
      return {
        name,
        description: typeof item.description === "string" ? item.description.trim().slice(0, 1000) : "",
        portionSize: typeof item.portion === "string" ? item.portion.trim().slice(0, 80) : "",
        dietaryTags,
        pricePaise: basePaise,
        variants: variants.map((variant) => ({
          name: variant.name,
          priceDeltaPaise: variant.pricePaise - basePaise,
        })),
      };
    }),
  }));
  if (categories.length === 0 || categories.some((category) => category.items.length === 0)) {
    throw new Error("Every category needs at least one dish.");
  }
  return {
    restaurant: {
      slug,
      name: text(restaurant.name, "Restaurant name", 120),
      description: typeof restaurant.description === "string" ? restaurant.description.trim().slice(0, 2000) : "",
      address: typeof restaurant.address === "string" ? restaurant.address.trim().slice(0, 300) : "",
      city: typeof restaurant.city === "string" ? restaurant.city.trim().slice(0, 100) : "",
      state: typeof restaurant.state === "string" ? restaurant.state.trim().slice(0, 100) : "",
      postalCode: typeof restaurant.postalCode === "string" ? restaurant.postalCode.trim().slice(0, 20) : "",
      dineInEnabled: restaurant.dineInEnabled !== false,
      takeawayEnabled: restaurant.takeawayEnabled !== false,
      deliveryEnabled: restaurant.deliveryEnabled === true,
    },
    categories,
  };
}

export function readSeedMenu(file = MENU_FILE) {
  return parseSeedMenu(JSON.parse(readFileSync(file, "utf8")));
}

/**
 * Runs inside the caller's transaction. An advisory lock serialises concurrent runs, since
 * dish names carry no unique constraint (an owner may legitimately reuse one later).
 */
export async function seedJagadamba(client, { ownerEmail, publish = false, menu = readSeedMenu() }) {
  const email = typeof ownerEmail === "string" ? ownerEmail.trim().toLowerCase() : "";
  if (!email) throw new Error("Pass --owner-email=<the owner's account email>.");
  const now = new Date().toISOString();
  const { restaurant, categories } = menu;

  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`seed-restaurant:${restaurant.slug}`]);
  const owner = (await client.query("SELECT id FROM users WHERE email = $1", [email])).rows[0];
  if (!owner) throw new Error(`No account for ${email}. Sign up on the site first, then run this again.`);

  let restaurantId;
  let createdRestaurant = false;
  const existing = (
    await client.query("SELECT id FROM managed_restaurants WHERE slug = $1 FOR UPDATE", [restaurant.slug])
  ).rows[0];
  if (existing) {
    restaurantId = existing.id;
    const member = await client.query(
      "SELECT 1 FROM restaurant_memberships WHERE restaurant_id = $1 AND user_id = $2",
      [restaurantId, owner.id]
    );
    if (!member.rowCount) {
      throw new Error(`${restaurant.slug} already exists and ${email} is not on its team; nothing was changed.`);
    }
  } else {
    restaurantId = `rst_${randomUUID()}`;
    createdRestaurant = true;
    await client.query(
      `INSERT INTO managed_restaurants
       (id, owner_user_id, slug, name, description, address, city, state, postal_code,
        delivery_enabled, takeaway_enabled, dine_in_enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)`,
      [
        restaurantId, owner.id, restaurant.slug, restaurant.name, restaurant.description,
        restaurant.address, restaurant.city, restaurant.state, restaurant.postalCode,
        Number(restaurant.deliveryEnabled), Number(restaurant.takeawayEnabled),
        Number(restaurant.dineInEnabled), now,
      ]
    );
    await client.query(
      `INSERT INTO restaurant_memberships (restaurant_id, user_id, role, granted_at, granted_by)
       VALUES ($1, $2, 'owner', $3, $2)`,
      [restaurantId, owner.id, now]
    );
    await client.query(
      `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, created_at)
       VALUES ($1, $2, 'RESTAURANT_CREATED', $1, $3)`,
      [restaurantId, owner.id, now]
    );
  }

  const known = new Set(
    (await client.query("SELECT lower(name) AS name FROM menu_items WHERE restaurant_id = $1", [restaurantId])).rows.map(
      (row) => row.name
    )
  );
  const created = [];
  const skipped = [];
  for (const [categoryIndex, category] of categories.entries()) {
    const missing = category.items.filter((item) => !known.has(item.name.toLowerCase()));
    skipped.push(...category.items.filter((item) => known.has(item.name.toLowerCase())).map((item) => item.name));
    // A category is only created for dishes it will hold, so a rerun after the owner renamed
    // one does not leave an empty duplicate behind.
    if (missing.length === 0) continue;
    await client.query(
      `INSERT INTO menu_categories (id, restaurant_id, name, display_order, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)
       ON CONFLICT (restaurant_id, name) DO NOTHING`,
      [`cat_${randomUUID()}`, restaurantId, category.name, categoryIndex, now]
    );
    const categoryId = (
      await client.query("SELECT id FROM menu_categories WHERE restaurant_id = $1 AND name = $2", [
        restaurantId,
        category.name,
      ])
    ).rows[0].id;
    for (const item of missing) {
      const itemId = `itm_${randomUUID()}`;
      await client.query(
        `INSERT INTO menu_items
         (id, restaurant_id, category_id, name, description, price_paise, dietary_tags, portion_size,
          available, published, display_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 1, 1, $9, $10, $10)`,
        [
          itemId, restaurantId, categoryId, item.name, item.description, item.pricePaise,
          item.dietaryTags, item.portionSize, category.items.indexOf(item), now,
        ]
      );
      for (const [variantIndex, variant] of item.variants.entries()) {
        await client.query(
          `INSERT INTO menu_item_variants (id, restaurant_id, item_id, name, price_delta_paise, display_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [`var_${randomUUID()}`, restaurantId, itemId, variant.name, variant.priceDeltaPaise, variantIndex]
        );
      }
      created.push(item.name);
    }
  }
  if (created.length) {
    await client.query(
      `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, detail, created_at)
       VALUES ($1, $2, 'MENU_SEEDED', $1, $3::jsonb, $4)`,
      [restaurantId, owner.id, JSON.stringify({ created: created.length, skipped: skipped.length }), now]
    );
  }

  let published = false;
  if (publish) {
    const updated = await client.query(
      `UPDATE managed_restaurants SET status = 'published', published_at = $2, updated_at = $2
       WHERE id = $1 AND status <> 'published'
         AND EXISTS (
           SELECT 1 FROM menu_items i
           JOIN menu_categories c ON c.id = i.category_id AND c.restaurant_id = i.restaurant_id
           WHERE i.restaurant_id = $1 AND i.published = 1 AND i.available = 1 AND c.visible = 1
         )`,
      [restaurantId, now]
    );
    if (updated.rowCount) {
      published = true;
      await client.query(
        `INSERT INTO restaurant_audit (restaurant_id, actor_id, action, subject, created_at)
         VALUES ($1, $2, 'RESTAURANT_PUBLISHED', $1, $3)`,
        [restaurantId, owner.id, now]
      );
    }
  }

  return { restaurantId, slug: restaurant.slug, createdRestaurant, created, skipped, published };
}

async function main() {
  const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const url = arg("url") || process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!url) throw new Error("No connection string: set DATABASE_URL in .env.local or pass --url=...");
  const isLocal = url.includes("localhost") || url.includes("127.0.0.1");
  const parsed = new URL(url);
  if (!isLocal) parsed.searchParams.set("sslmode", "verify-full");
  const client = new pg.Client({
    connectionString: parsed.toString(),
    ssl: isLocal ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 20_000,
  });
  await client.connect();
  try {
    console.info(`Seeding ${parsed.hostname}${parsed.pathname} ...`);
    await client.query("BEGIN");
    const result = await seedJagadamba(client, {
      ownerEmail: arg("owner-email"),
      publish: process.argv.includes("--publish"),
    });
    await client.query("COMMIT");
    console.info(
      `${result.createdRestaurant ? "Created" : "Found"} ${result.slug} (${result.restaurantId}). ` +
        `Added ${result.created.length} dishes, kept ${result.skipped.length} that already existed.` +
        (result.published ? " Published." : "")
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Failed: ${error.message}`);
    process.exitCode = 1;
  });
}
