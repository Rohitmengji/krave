import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Single-file SQLite store for this single-machine demo. Node's built-in driver is used so
 * the project stays dependency-free; it is still flagged experimental by Node 22.
 */
const DB_PATH = process.env.KRAVE_DB_PATH || path.join(process.cwd(), ".data", "krave.db");

let instance: DatabaseSync | null = null;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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

CREATE TABLE IF NOT EXISTS pos_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES pos_sessions(id) ON DELETE CASCADE,
  kot_number INTEGER NOT NULL,
  fired_at TEXT NOT NULL,
  merged_from TEXT,
  lines_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pos_tickets_session_idx ON pos_tickets(session_id);

CREATE TABLE IF NOT EXISTS pos_voids (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_subject_idx ON audit_log(subject, at DESC);

-- Append-only is enforced here rather than by convention, so a later bug or a
-- careless query cannot quietly rewrite the record of who did what.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
`;

/** Columns added after the first release; existing files need them backfilled. */
const ADDED_COLUMNS: Array<{ table: string; column: string; definition: string }> = [
  { table: "disputes", column: "assessed_amount", definition: "INTEGER NOT NULL DEFAULT 0" },
  { table: "disputes", column: "resolved_at", definition: "TEXT" },
  { table: "disputes", column: "resolved_by", definition: "TEXT" },
  { table: "disputes", column: "resolution_note", definition: "TEXT" },
];

function migrate(db: DatabaseSync): void {
  for (const { table, column, definition } of ADDED_COLUMNS) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Record<string, unknown>[];
    if (existing.length === 0) continue;
    if (existing.some((row) => String(row.name) === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function getDb(): DatabaseSync {
  if (instance) return instance;
  mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec(SCHEMA);
  migrate(db);
  instance = db;
  return db;
}

/** Used by tests to run against a throwaway database. */
export function useTestDb(db: DatabaseSync): void {
  db.exec(SCHEMA);
  migrate(db);
  instance = db;
}
