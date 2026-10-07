const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  address_line1 TEXT,
  address_line2 TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  native_place TEXT,
  date_of_birth TEXT,
  occupation TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS household_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relationship TEXT,
  birth_year INTEGER
);

CREATE TABLE IF NOT EXISTS membership_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  duration_months INTEGER NOT NULL CHECK (duration_months > 0),
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS memberships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id INTEGER REFERENCES membership_plans(id),
  payment_id INTEGER REFERENCES payments(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  rsvp_deadline TEXT,
  fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  capacity INTEGER,
  max_party_size INTEGER NOT NULL DEFAULT 10,
  members_only INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'cancelled')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rsvps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  party_size INTEGER NOT NULL CHECK (party_size > 0),
  status TEXT NOT NULL CHECK (status IN ('pending_payment', 'confirmed', 'cancelled')),
  qr_token TEXT NOT NULL UNIQUE,
  notes TEXT,
  checked_in_at TEXT,
  checked_in_by INTEGER REFERENCES users(id),
  checked_in_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, user_id)
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('membership', 'event', 'other')),
  reference_id INTEGER,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
  method TEXT CHECK (method IN ('stripe', 'demo', 'cash', 'check', 'other')),
  provider_ref TEXT,
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

-- QR codes that were replaced (guest count changed, RSVP re-opened). Kept so a scan of an
-- old code can say "replaced" instead of just "invalid".
CREATE TABLE IF NOT EXISTS retired_qr_tokens (
  token TEXT PRIMARY KEY,
  rsvp_id INTEGER NOT NULL REFERENCES rsvps(id) ON DELETE CASCADE,
  reason TEXT,
  retired_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Money returned to a member for an event RSVP (fewer guests, or cancellation).
CREATE TABLE IF NOT EXISTS refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rsvp_id INTEGER NOT NULL REFERENCES rsvps(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL,
  note TEXT,
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rsvps_event ON rsvps(event_id);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

// Runs fn inside a transaction; rolls back if it throws.
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

module.exports = { openDb, transaction };
