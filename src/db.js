const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Contacts (donors, sponsors, imported members…) may have no email and no login yet.
  email TEXT UNIQUE COLLATE NOCASE,
  password_hash TEXT,
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
  -- Member directory privacy: listed by name/city/vatan, and optionally with phone & email.
  directory_listed INTEGER NOT NULL DEFAULT 1,
  directory_contact INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '',          -- comma-separated: Donor, Sponsor, Vendor, Volunteer, …
  source TEXT NOT NULL DEFAULT 'signup',  -- signup | admin | import
  language TEXT,                          -- 'en' | 'gu' (display preference)
  text_size TEXT,                         -- 'normal' | 'large' | 'xlarge'
  checkin_access INTEGER NOT NULL DEFAULT 0, -- door volunteer: may use the check-in scanner
  -- Family login: a spouse/child/parent with their own sign-in, covered by this member's membership.
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS household_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relationship TEXT,
  birth_year INTEGER,
  email TEXT COLLATE NOCASE,                                         -- set by the member so this person can get their own login
  login_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL      -- their login, once they've joined
);

CREATE TABLE IF NOT EXISTS membership_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  name_gu TEXT,
  description TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  duration_months INTEGER NOT NULL CHECK (duration_months > 0),
  -- Who besides the member the plan covers (these limit the family on the profile,
  -- which in turn limits how many people the member can RSVP for).
  spouse_allowed INTEGER NOT NULL DEFAULT 0,
  children_allowed INTEGER NOT NULL DEFAULT 0,
  max_parents INTEGER NOT NULL DEFAULT 0,
  min_age INTEGER NOT NULL DEFAULT 0,
  -- 1 = membership runs Jan 1 – Dec 31 (renewing extends to the end of next year).
  calendar_year INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
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
  title_gu TEXT,        -- optional Gujarati versions shown to Gujarati readers
  description_gu TEXT,
  location TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  rsvp_deadline TEXT,
  fee_cents INTEGER NOT NULL DEFAULT 0 CHECK (fee_cents >= 0),
  capacity INTEGER,
  max_party_size INTEGER NOT NULL DEFAULT 10,
  members_only INTEGER NOT NULL DEFAULT 0,
  guest_fee_cents INTEGER CHECK (guest_fee_cents >= 0), -- NULL = guests not allowed
  max_guests INTEGER NOT NULL DEFAULT 4,
  early_fee_cents INTEGER CHECK (early_fee_cents >= 0), -- early-bird member price…
  early_until TEXT,                                     -- …until this date-time
  image_path TEXT,
  questions TEXT NOT NULL DEFAULT '[]',                 -- JSON: custom registration questions
  status TEXT NOT NULL DEFAULT 'published' CHECK (status IN ('draft', 'published', 'cancelled')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rsvps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  party_size INTEGER NOT NULL CHECK (party_size > 0), -- everyone coming, guests included
  guest_count INTEGER NOT NULL DEFAULT 0,               -- of whom non-family guests
  total_cents INTEGER NOT NULL DEFAULT 0,               -- price for this RSVP after discounts
  discount_cents INTEGER NOT NULL DEFAULT 0,
  coupon_code TEXT,
  answers TEXT NOT NULL DEFAULT '[]',                   -- JSON: answers to the event's questions
  status TEXT NOT NULL CHECK (status IN ('pending_payment', 'confirmed', 'waitlisted', 'cancelled')),
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
  kind TEXT NOT NULL CHECK (kind IN ('membership', 'membership_upgrade', 'event', 'donation', 'other')),
  reference_id INTEGER, -- plan, RSVP or campaign, depending on kind
  note TEXT,
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
  method TEXT CHECK (method IN ('stripe', 'demo', 'cash', 'check', 'other')),
  provider_ref TEXT,
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT
);

-- Who an RSVP is for, by name: the member ('u:<user id>') and family on their profile
-- ('h:<household member id>'). A person can be on only one active RSVP per event.
CREATE TABLE IF NOT EXISTS rsvp_attendees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rsvp_id INTEGER NOT NULL REFERENCES rsvps(id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person TEXT NOT NULL,
  name TEXT NOT NULL,
  relationship TEXT
);

-- QR codes that were replaced (guest count changed, RSVP re-opened). Kept so a scan of an
-- old code can say "replaced" instead of just "invalid".
CREATE TABLE IF NOT EXISTS retired_qr_tokens (
  token TEXT PRIMARY KEY,
  rsvp_id INTEGER NOT NULL REFERENCES rsvps(id) ON DELETE CASCADE,
  reason TEXT,
  retired_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS news_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  title_gu TEXT,
  body_gu TEXT,
  image_path TEXT,
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE COLLATE NOCASE,
  event_id INTEGER REFERENCES events(id) ON DELETE CASCADE, -- NULL = any event
  percent_off INTEGER CHECK (percent_off BETWEEN 1 AND 100),
  amount_off_cents INTEGER CHECK (amount_off_cents > 0),
  max_uses INTEGER,
  expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  goal_cents INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Admin-editable website content (About, Contact, Committee, Sponsors), stored as JSON.
CREATE TABLE IF NOT EXISTS pages (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  sess TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_rsvps_event ON rsvps(event_id);
CREATE INDEX IF NOT EXISTS idx_attendees_rsvp ON rsvp_attendees(rsvp_id);
CREATE INDEX IF NOT EXISTS idx_attendees_event ON rsvp_attendees(event_id, person);
CREATE UNIQUE INDEX IF NOT EXISTS idx_household_email ON household_members(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_kind ON payments(kind, status);
`;

const SCHEMA_VERSION = 5;

// Upgrades for databases created by an earlier version (keyed by the version they produce).
const MIGRATIONS = {
  4: ['ALTER TABLE users ADD COLUMN checkin_access INTEGER NOT NULL DEFAULT 0'],
  // rsvp_attendees itself is created by SCHEMA. Older RSVPs have no names and show a head count.
  5: [
    'ALTER TABLE users ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL',
    'ALTER TABLE household_members ADD COLUMN email TEXT COLLATE NOCASE',
    'ALTER TABLE household_members ADD COLUMN login_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL',
  ],
  3: [
    'ALTER TABLE users ADD COLUMN language TEXT',
    'ALTER TABLE users ADD COLUMN text_size TEXT',
    'ALTER TABLE events ADD COLUMN title_gu TEXT',
    'ALTER TABLE events ADD COLUMN description_gu TEXT',
    'ALTER TABLE news_posts ADD COLUMN title_gu TEXT',
    'ALTER TABLE news_posts ADD COLUMN body_gu TEXT',
    'ALTER TABLE membership_plans ADD COLUMN name_gu TEXT',
  ],
};

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const hasTables = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'`).get();
  if (hasTables && version < 2) {
    throw new Error(`The database at ${file} was created by an early preview of this app. `
      + 'It only holds demo data, so delete the file (and its -wal/-shm files) and start again.');
  }
  if (hasTables) {
    for (let v = version + 1; v <= SCHEMA_VERSION; v++) {
      transaction(db, () => (MIGRATIONS[v] || []).forEach((sql) => db.exec(sql)));
    }
  }
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
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
