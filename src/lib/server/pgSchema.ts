/**
 * Postgres schema, ported from the SQLite one.
 *
 * Differences worth knowing, because they are not cosmetic:
 *  - `INTEGER PRIMARY KEY AUTOINCREMENT` becomes `GENERATED ALWAYS AS IDENTITY`.
 *  - Postgres has no `CREATE TRIGGER IF NOT EXISTS`, so triggers are dropped first.
 *  - SQLite's `RAISE(ABORT, ...)` becomes a PL/pgSQL `RAISE EXCEPTION`.
 *  - Timestamps stay as ISO-8601 text rather than becoming `timestamptz`. They sort
 *    correctly as text, and changing the type would mean reworking every date path at
 *    the same time as the driver, which is two risky changes at once.
 *  - Booleans stay as integers for the same reason: one migration at a time.
 */
export const PG_SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  is_gold_member INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  attempt_key TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  succeeded INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS login_attempts_key_idx ON login_attempts(attempt_key, attempted_at);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets(user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
-- Accounts that predate verification count as verified; the default applies only to rows
-- that exist when the column is added, and new sign-ups start unverified.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TEXT DEFAULT '2026-10-23T00:00:00.000Z';
ALTER TABLE users ALTER COLUMN email_verified_at DROP DEFAULT;

CREATE TABLE IF NOT EXISTS email_tokens (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL CHECK (purpose IN ('verify', 'change')),
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS email_tokens_user_idx ON email_tokens(user_id, purpose);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  res_id INTEGER NOT NULL,
  address_id TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  coupon_code TEXT,
  is_gold_member INTEGER NOT NULL,
  rider_tip INTEGER NOT NULL,
  scheduled_slot TEXT NOT NULL,
  due_at TEXT NOT NULL,
  stage TEXT NOT NULL,
  grand_total INTEGER NOT NULL,
  placed_at TEXT NOT NULL,
  idempotency_key TEXT
);
CREATE INDEX IF NOT EXISTS orders_user_idx ON orders(user_id, placed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS orders_idempotency_idx
  ON orders(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS order_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  option_ids TEXT NOT NULL,
  cooking_instruction TEXT
);
CREATE INDEX IF NOT EXISTS order_lines_order_idx ON order_lines(order_id);

CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  res_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  time_slot TEXT NOT NULL,
  guests INTEGER NOT NULL,
  guest_name TEXT NOT NULL,
  guest_phone TEXT NOT NULL,
  special_request TEXT NOT NULL,
  offer_applied TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reservations_user_idx ON reservations(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  res_id INTEGER NOT NULL,
  PRIMARY KEY (user_id, res_id)
);

CREATE TABLE IF NOT EXISTS pos_shifts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outlet_id INTEGER NOT NULL,
  outlet_name TEXT NOT NULL,
  opened_by TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  opening_cash INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS pos_shifts_user_idx ON pos_shifts(user_id);

CREATE TABLE IF NOT EXISTS pos_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shift_id TEXT,
  outlet_id INTEGER NOT NULL,
  outlet_name TEXT NOT NULL,
  table_id TEXT NOT NULL,
  guest_count INTEGER NOT NULL,
  server_name TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  status TEXT NOT NULL,
  discount_percent INTEGER NOT NULL,
  service_charge_percent INTEGER NOT NULL,
  next_kot_number INTEGER NOT NULL,
  merged_into_session_id TEXT,
  payment_method TEXT,
  payment_amount_tendered INTEGER,
  payment_change_due INTEGER,
  payment_settled_at TEXT,
  synced_at TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS pos_sessions_user_idx ON pos_sessions(user_id, opened_at DESC);
-- Names and mobile numbers guests gave at the table, so their bill can be texted to them.
ALTER TABLE pos_sessions ADD COLUMN IF NOT EXISTS guests_json TEXT NOT NULL DEFAULT '[]';
-- Rows from before the rate was per restaurant were all billed at 5% GST.
ALTER TABLE pos_sessions ADD COLUMN IF NOT EXISTS tax_rate_bps INTEGER NOT NULL DEFAULT 500;

CREATE TABLE IF NOT EXISTS pos_lines (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES pos_sessions(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  dietary TEXT NOT NULL,
  note TEXT NOT NULL,
  kot_number INTEGER
);
CREATE INDEX IF NOT EXISTS pos_lines_session_idx ON pos_lines(session_id);

CREATE TABLE IF NOT EXISTS pos_tickets (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES pos_sessions(id) ON DELETE CASCADE,
  kot_number INTEGER NOT NULL,
  fired_at TEXT NOT NULL,
  merged_from TEXT,
  lines_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pos_tickets_session_idx ON pos_tickets(session_id);

CREATE TABLE IF NOT EXISTS pos_voids (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES pos_sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  reason TEXT NOT NULL,
  voided_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pos_voids_session_idx ON pos_voids(session_id);

-- Keyed by outlet, not by device or account: a dish sold out at the counter is sold out
-- for everyone looking at that menu.
CREATE TABLE IF NOT EXISTS dish_availability (
  outlet_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  marked_at TEXT NOT NULL,
  marked_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (outlet_id, item_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);

-- What the kitchen needs to cook a delivery order, and nothing more. Deliberately carries
-- no customer name, address or phone: a counter screen has no use for them, and keeping
-- them out means an operator cannot read them off it.
CREATE TABLE IF NOT EXISTS delivery_tickets (
  order_id TEXT PRIMARY KEY,
  outlet_id INTEGER NOT NULL,
  placed_at TEXT NOT NULL,
  scheduled_slot TEXT NOT NULL,
  due_at TEXT NOT NULL,
  flags TEXT NOT NULL,
  allergy_note TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  status TEXT NOT NULL,
  accepted_at TEXT,
  ready_at TEXT
);
CREATE INDEX IF NOT EXISTS delivery_tickets_outlet_idx
  ON delivery_tickets(outlet_id, status, due_at);

-- A settled table bill, claimable by whoever holds the receipt. The counter never records
-- who the guest was; the customer links it afterwards with the printed code, so dine-in and
-- delivery history can meet on one account without staff seeing any of it.
CREATE TABLE IF NOT EXISTS dine_in_bills (
  session_id TEXT PRIMARY KEY,
  outlet_id INTEGER NOT NULL,
  outlet_name TEXT NOT NULL,
  table_id TEXT NOT NULL,
  guest_count INTEGER NOT NULL,
  settled_at TEXT NOT NULL,
  payment_method TEXT NOT NULL,
  grand_total INTEGER NOT NULL,
  lines_json TEXT NOT NULL,
  claim_code TEXT NOT NULL UNIQUE,
  claimed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  claimed_at TEXT
);
CREATE INDEX IF NOT EXISTS dine_in_bills_claimed_idx
  ON dine_in_bills(claimed_by, settled_at DESC);

CREATE TABLE IF NOT EXISTS disputes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  refund_amount INTEGER NOT NULL,
  -- What the claim was worth when filed, so approving it later cannot drift with the catalog.
  assessed_amount INTEGER NOT NULL DEFAULT 0,
  explanation TEXT NOT NULL,
  filed_at TEXT NOT NULL,
  review_due_at TEXT,
  note TEXT NOT NULL,
  resolved_at TEXT,
  resolved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolution_note TEXT
);
-- One claim per order, so a double submit cannot refund twice.
CREATE UNIQUE INDEX IF NOT EXISTS disputes_order_idx ON disputes(order_id);
CREATE INDEX IF NOT EXISTS disputes_user_idx ON disputes(user_id, filed_at DESC);
CREATE INDEX IF NOT EXISTS disputes_status_idx ON disputes(status, filed_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_subject_idx ON audit_log(subject, at DESC);

CREATE TABLE IF NOT EXISTS outlet_staff (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  outlet_id INTEGER NOT NULL,
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  PRIMARY KEY (user_id, outlet_id)
);

CREATE TABLE IF NOT EXISTS managed_restaurants (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  phone TEXT,
  email TEXT,
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT '',
  postal_code TEXT NOT NULL DEFAULT '',
  service_areas JSONB NOT NULL DEFAULT '[]'::jsonb,
  logo_asset_id TEXT,
  cover_asset_id TEXT,
  gallery_asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  delivery_enabled INTEGER NOT NULL DEFAULT 0,
  takeaway_enabled INTEGER NOT NULL DEFAULT 1,
  dine_in_enabled INTEGER NOT NULL DEFAULT 1,
  minimum_order_paise INTEGER NOT NULL DEFAULT 0 CHECK (minimum_order_paise >= 0),
  delivery_fee_paise INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee_paise >= 0),
  tax_rate_bps INTEGER NOT NULL DEFAULT 0 CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  tax_enabled INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'pending', 'published', 'suspended')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS managed_restaurants_owner_idx
  ON managed_restaurants(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS managed_restaurants_public_idx
  ON managed_restaurants(status, slug);

CREATE TABLE IF NOT EXISTS restaurant_memberships (
  restaurant_id TEXT NOT NULL REFERENCES managed_restaurants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'manager', 'staff')),
  granted_at TEXT NOT NULL,
  granted_by TEXT NOT NULL,
  PRIMARY KEY (restaurant_id, user_id)
);
CREATE INDEX IF NOT EXISTS restaurant_memberships_user_idx
  ON restaurant_memberships(user_id, restaurant_id);

CREATE TABLE IF NOT EXISTS restaurant_operating_hours (
  restaurant_id TEXT NOT NULL REFERENCES managed_restaurants(id) ON DELETE CASCADE,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  opens_at TEXT,
  closes_at TEXT,
  is_closed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (restaurant_id, weekday),
  CHECK ((is_closed = 1 AND opens_at IS NULL AND closes_at IS NULL)
    OR (is_closed = 0 AND opens_at IS NOT NULL AND closes_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS restaurant_assets (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES managed_restaurants(id) ON DELETE CASCADE,
  uploaded_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  object_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('menu_document', 'menu_item_image', 'logo', 'cover', 'gallery')),
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size > 0),
  source_url TEXT,
  source_name TEXT,
  license TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (id, restaurant_id)
);
CREATE INDEX IF NOT EXISTS restaurant_assets_owner_idx
  ON restaurant_assets(restaurant_id, kind, created_at DESC);
ALTER TABLE managed_restaurants DROP CONSTRAINT IF EXISTS managed_restaurants_logo_asset_fk;
ALTER TABLE managed_restaurants ADD CONSTRAINT managed_restaurants_logo_asset_fk
  FOREIGN KEY (logo_asset_id, id) REFERENCES restaurant_assets(id, restaurant_id)
  ON DELETE SET NULL (logo_asset_id);
ALTER TABLE managed_restaurants DROP CONSTRAINT IF EXISTS managed_restaurants_cover_asset_fk;
ALTER TABLE managed_restaurants ADD CONSTRAINT managed_restaurants_cover_asset_fk
  FOREIGN KEY (cover_asset_id, id) REFERENCES restaurant_assets(id, restaurant_id)
  ON DELETE SET NULL (cover_asset_id);

CREATE TABLE IF NOT EXISTS menu_categories (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES managed_restaurants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  display_order INTEGER NOT NULL DEFAULT 0,
  visible INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, restaurant_id),
  UNIQUE (restaurant_id, name)
);
CREATE INDEX IF NOT EXISTS menu_categories_order_idx
  ON menu_categories(restaurant_id, visible, display_order);

CREATE TABLE IF NOT EXISTS menu_import_jobs (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES managed_restaurants(id) ON DELETE CASCADE,
  source_asset_id TEXT NOT NULL,
  requested_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('uploaded', 'processing', 'review', 'failed', 'imported')),
  extracted_items JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  imported_at TEXT,
  FOREIGN KEY (source_asset_id, restaurant_id)
    REFERENCES restaurant_assets(id, restaurant_id) ON DELETE CASCADE,
  UNIQUE (id, restaurant_id)
);
CREATE INDEX IF NOT EXISTS menu_import_jobs_restaurant_idx
  ON menu_import_jobs(restaurant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS menu_items (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES managed_restaurants(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  discounted_price_paise INTEGER CHECK (discounted_price_paise >= 0),
  dietary_tags TEXT[] NOT NULL DEFAULT '{}',
  allergens TEXT[] NOT NULL DEFAULT '{}',
  portion_size TEXT NOT NULL DEFAULT '',
  prep_minutes INTEGER CHECK (prep_minutes IS NULL OR prep_minutes BETWEEN 0 AND 1440),
  spicy_level SMALLINT CHECK (spicy_level IS NULL OR spicy_level BETWEEN 0 AND 5),
  available INTEGER NOT NULL DEFAULT 1,
  published INTEGER NOT NULL DEFAULT 0,
  featured INTEGER NOT NULL DEFAULT 0,
  image_asset_id TEXT,
  display_order INTEGER NOT NULL DEFAULT 0,
  source_import_id TEXT,
  source_import_item_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, restaurant_id),
  FOREIGN KEY (category_id, restaurant_id)
    REFERENCES menu_categories(id, restaurant_id) ON DELETE RESTRICT,
  FOREIGN KEY (image_asset_id, restaurant_id)
    REFERENCES restaurant_assets(id, restaurant_id) ON DELETE SET NULL (image_asset_id),
  FOREIGN KEY (source_import_id, restaurant_id)
    REFERENCES menu_import_jobs(id, restaurant_id) ON DELETE SET NULL (source_import_id),
  CHECK (discounted_price_paise IS NULL OR discounted_price_paise <= price_paise)
);
-- Optimistic concurrency: an edit names the revision it was based on, so a save from a
-- stale tab or second device is refused instead of silently overwriting the newer one.
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS revision INTEGER NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS menu_items_public_idx
  ON menu_items(restaurant_id, published, available, category_id, display_order);
CREATE UNIQUE INDEX IF NOT EXISTS menu_items_import_source_idx
  ON menu_items(source_import_id, source_import_item_id)
  WHERE source_import_id IS NOT NULL AND source_import_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS menu_item_variants (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price_delta_paise INTEGER NOT NULL CHECK (price_delta_paise >= 0),
  display_order INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (item_id, restaurant_id)
    REFERENCES menu_items(id, restaurant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS menu_item_variants_item_idx
  ON menu_item_variants(restaurant_id, item_id, display_order);

CREATE TABLE IF NOT EXISTS menu_item_addons (
  id TEXT PRIMARY KEY,
  restaurant_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  name TEXT NOT NULL,
  price_paise INTEGER NOT NULL CHECK (price_paise >= 0),
  display_order INTEGER NOT NULL DEFAULT 0,
  available INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (item_id, restaurant_id)
    REFERENCES menu_items(id, restaurant_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS menu_item_addons_item_idx
  ON menu_item_addons(restaurant_id, item_id, display_order);

CREATE TABLE IF NOT EXISTS restaurant_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  restaurant_id TEXT NOT NULL REFERENCES managed_restaurants(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS restaurant_audit_history_idx
  ON restaurant_audit(restaurant_id, created_at DESC);

-- Online ordering from the public menu stays off until the owner switches it on.
ALTER TABLE managed_restaurants ADD COLUMN IF NOT EXISTS accepting_orders INTEGER NOT NULL DEFAULT 0;
ALTER TABLE managed_restaurants ADD COLUMN IF NOT EXISTS time_zone TEXT NOT NULL DEFAULT 'Asia/Kolkata';
-- The table terminal and its bills key outlets by integer; existing rows are numbered on add.
ALTER TABLE managed_restaurants ADD COLUMN IF NOT EXISTS pos_outlet_id INTEGER GENERATED BY DEFAULT AS IDENTITY;
CREATE UNIQUE INDEX IF NOT EXISTS managed_restaurants_pos_outlet_idx ON managed_restaurants(pos_outlet_id);

-- Orders from a managed menu. Payment is collected by the restaurant (at the counter or
-- on delivery); nothing here records or moves money online.
CREATE TABLE IF NOT EXISTS restaurant_orders (
  id TEXT PRIMARY KEY,
  -- RESTRICT: order history outlives any attempt to remove the restaurant.
  restaurant_id TEXT NOT NULL REFERENCES managed_restaurants(id) ON DELETE RESTRICT,
  order_number INTEGER NOT NULL CHECK (order_number > 0),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  customer_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  fulfilment TEXT NOT NULL CHECK (fulfilment IN ('takeaway', 'dine_in', 'delivery')),
  delivery_address TEXT,
  service_area TEXT,
  note TEXT NOT NULL DEFAULT '',
  subtotal_paise INTEGER NOT NULL CHECK (subtotal_paise > 0),
  delivery_fee_paise INTEGER NOT NULL CHECK (delivery_fee_paise >= 0),
  tax_rate_bps INTEGER NOT NULL CHECK (tax_rate_bps BETWEEN 0 AND 10000),
  tax_paise INTEGER NOT NULL CHECK (tax_paise >= 0),
  total_paise INTEGER NOT NULL
    CHECK (total_paise = subtotal_paise + delivery_fee_paise + tax_paise),
  payment_method TEXT NOT NULL DEFAULT 'pay_at_restaurant'
    CHECK (payment_method IN ('pay_at_restaurant', 'pay_on_delivery')),
  status TEXT NOT NULL
    CHECK (status IN ('placed', 'accepted', 'preparing', 'ready', 'completed', 'cancelled', 'rejected')),
  status_reason TEXT,
  status_changed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  placed_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((fulfilment = 'delivery') = (delivery_address IS NOT NULL)),
  UNIQUE (restaurant_id, idempotency_key),
  UNIQUE (restaurant_id, order_number)
);
CREATE INDEX IF NOT EXISTS restaurant_orders_queue_idx
  ON restaurant_orders(restaurant_id, status, placed_at DESC);
CREATE INDEX IF NOT EXISTS restaurant_orders_history_idx
  ON restaurant_orders(restaurant_id, placed_at DESC, id DESC);

-- A snapshot of each line as it was priced. Deliberately no foreign key to menu_items:
-- editing or deleting a dish later must not change or remove what was ordered.
CREATE TABLE IF NOT EXISTS restaurant_order_lines (
  order_id TEXT NOT NULL REFERENCES restaurant_orders(id) ON DELETE CASCADE,
  line_no SMALLINT NOT NULL CHECK (line_no > 0),
  menu_item_id TEXT NOT NULL,
  variant_id TEXT,
  item_name TEXT NOT NULL,
  variant_name TEXT,
  addons JSONB NOT NULL DEFAULT '[]'::jsonb,
  unit_price_paise INTEGER NOT NULL CHECK (unit_price_paise >= 0),
  quantity INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  line_total_paise INTEGER NOT NULL CHECK (line_total_paise = unit_price_paise * quantity),
  PRIMARY KEY (order_id, line_no)
);

-- Append-only is enforced by the database, so a later bug or a careless query cannot
-- quietly rewrite the record of who did what.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update
BEFORE UPDATE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
CREATE TRIGGER audit_log_no_delete
BEFORE DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();

-- TRUNCATE does not fire row-level triggers, so without this the two above are
-- bypassable by one statement. Statement-level is the only level TRUNCATE honours.
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate
BEFORE TRUNCATE ON audit_log
FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
`;

/** Every table, for the test helper that empties the database between cases. */
export const PG_TABLES = [
  "restaurant_order_lines",
  "restaurant_orders",
  "restaurant_audit",
  "menu_item_addons",
  "menu_item_variants",
  "menu_items",
  "menu_import_jobs",
  "menu_categories",
  "restaurant_assets",
  "restaurant_operating_hours",
  "restaurant_memberships",
  "managed_restaurants",
  "audit_log",
  "outlet_staff",
  "disputes",
  "dine_in_bills",
  "delivery_tickets",
  "notifications",
  "dish_availability",
  "pos_voids",
  "pos_tickets",
  "pos_lines",
  "pos_sessions",
  "pos_shifts",
  "bookmarks",
  "reservations",
  "order_lines",
  "orders",
  "email_tokens",
  "password_resets",
  "login_attempts",
  "sessions",
  "users",
] as const;
