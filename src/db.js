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
  birth_year INTEGER,                     -- birth month and year (required for members); the day is optional,
  birth_month INTEGER CHECK (birth_month BETWEEN 1 AND 12),
  birthday TEXT,                          -- 'MM-DD', added under Celebrations to have the birthday announced
  occupation TEXT,
  notes TEXT,
  -- Member directory privacy: listed by name/city/vatan, and optionally with phone & email.
  directory_listed INTEGER NOT NULL DEFAULT 1,
  directory_contact INTEGER NOT NULL DEFAULT 0,
  tags TEXT NOT NULL DEFAULT '',          -- comma-separated: Donor, Sponsor, Vendor, Volunteer, …
  source TEXT NOT NULL DEFAULT 'signup',  -- signup | admin | import
  language TEXT,                          -- 'en' | 'gu' (display preference)
  text_size TEXT,                         -- 'normal' | 'large' | 'xlarge'
  theme TEXT,                             -- 'dark' (default) | 'light' | 'auto' (follow the phone)
  -- Celebrations: members choose to share their birthday (month and day only) and wedding anniversary.
  share_birthday INTEGER NOT NULL DEFAULT 0,
  anniversary TEXT,                       -- YYYY-MM-DD
  share_anniversary INTEGER NOT NULL DEFAULT 0,
  -- Sponsors & vendors are kept apart from members. For them first_name holds the organization's name
  -- (last_name is empty), so payments, receipts and exports show the business name.
  contact_type TEXT NOT NULL DEFAULT 'member',  -- 'member' | 'business'
  contact_person TEXT,
  website TEXT,
  sponsor_level TEXT,                     -- Platinum, Gold, … (sponsors)
  sponsor_year INTEGER,
  show_on_website INTEGER NOT NULL DEFAULT 0,  -- listed on the public Sponsors page
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
  birth_month INTEGER CHECK (birth_month BETWEEN 1 AND 12), -- with birth_year: required for children, locked once saved (admins can correct)
  email TEXT COLLATE NOCASE,                                         -- set by the member so this person can get their own login
  login_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,     -- their login, once they've joined
  invite_token TEXT,                 -- private single-use link the member shares so this person can join
  invite_expires TEXT,
  birthday TEXT,                     -- MM-DD, only for the Celebrations list
  share_birthday INTEGER NOT NULL DEFAULT 0
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
  guest_fee_cents INTEGER CHECK (guest_fee_cents >= 0), -- in-state non-members and guests; NULL = guests not allowed
  out_of_state_fee_cents INTEGER CHECK (out_of_state_fee_cents >= 0), -- out-of-state guests; NULL = no such price
  student_fee_cents INTEGER CHECK (student_fee_cents >= 0),           -- students with a school ID (one person each); NULL = none
  child_free_age INTEGER CHECK (child_free_age >= 0),                 -- children this age and under come free; NULL = no rule
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
  guest_types TEXT NOT NULL DEFAULT '{}',               -- JSON counts by kind: instate, outofstate, student, child
  total_cents INTEGER NOT NULL DEFAULT 0,               -- price for this RSVP after discounts
  discount_cents INTEGER NOT NULL DEFAULT 0,
  coupon_code TEXT,
  answers TEXT NOT NULL DEFAULT '[]',                   -- JSON: answers to the event's questions
  status TEXT NOT NULL CHECK (status IN ('pending_payment', 'confirmed', 'waitlisted', 'cancelled')),
  pay_at_door INTEGER NOT NULL DEFAULT 0,               -- 1: paying cash at the door, so confirmed (with a QR code) while still owing
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
  method TEXT CHECK (method IN ('stripe', 'paypal', 'venmo', 'demo', 'cash', 'check', 'other')),
  provider_ref TEXT,
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at TEXT,
  refunded_at TEXT -- money that arrived but couldn't be applied (e.g. dues beyond one year ahead) and was given back
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

-- Photo albums for members, grouped by type of event (category keys are in src/photos.js).
CREATE TABLE IF NOT EXISTS photo_albums (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  title_gu TEXT,
  category TEXT NOT NULL DEFAULT 'other',
  event_id INTEGER REFERENCES events(id) ON DELETE SET NULL,
  description TEXT,
  taken_on TEXT,                     -- date the photos are from (YYYY-MM-DD)
  cover_photo_id INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Files live in the private photos folder (not the public uploads), served only to signed-in members.
CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  album_id INTEGER NOT NULL REFERENCES photo_albums(id) ON DELETE CASCADE,
  file TEXT NOT NULL,                -- <name>.jpg full size, <name>_t.jpg thumbnail
  width INTEGER,
  height INTEGER,
  caption TEXT,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  -- Ready for member uploads later: theirs would wait as 'pending' until an admin approves.
  status TEXT NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'pending')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
CREATE INDEX IF NOT EXISTS idx_photos_album ON photos(album_id, status);
CREATE INDEX IF NOT EXISTS idx_attendees_event ON rsvp_attendees(event_id, person);
CREATE UNIQUE INDEX IF NOT EXISTS idx_household_email ON household_members(email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_household_invite ON household_members(invite_token) WHERE invite_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON memberships(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_kind ON payments(kind, status);

-- Gujarat & India news: headlines and short summaries from news sites the committee chooses.
CREATE TABLE IF NOT EXISTS news_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  lang TEXT NOT NULL DEFAULT 'en',        -- 'en' | 'gu'
  topic TEXT NOT NULL DEFAULT 'India',
  enabled INTEGER NOT NULL DEFAULT 1,
  last_checked_at TEXT,
  last_ok_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS news_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL REFERENCES news_sources(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  link TEXT NOT NULL,
  published_at TEXT NOT NULL,             -- UTC, YYYY-MM-DD HH:MM:SS
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  hidden INTEGER NOT NULL DEFAULT 0,      -- hidden by the committee
  UNIQUE (source_id, guid)
);
CREATE INDEX IF NOT EXISTS idx_news_items_published ON news_items(published_at);
`;

const SCHEMA_VERSION = 15; // 6: photo albums (new tables only, created by SCHEMA); 7: payments.refunded_at; 8: family invite links; 9: light/dark choice;
// 10: celebrations (birthdays, anniversaries) and Gujarat & India news (new tables created by SCHEMA); 11: sponsors & vendors;
// 12: pay at the door; 13: PayPal and Venmo payment methods; 14: children's birth month, guest types, age-free children;
// 15: members' birth month and year (the day only for Celebrations) in place of a full date of birth

// Upgrades for databases created by an earlier version (keyed by the version they produce).
const MIGRATIONS = {
  15: [
    'ALTER TABLE users ADD COLUMN birth_year INTEGER',
    'ALTER TABLE users ADD COLUMN birth_month INTEGER CHECK (birth_month BETWEEN 1 AND 12)',
    'ALTER TABLE users ADD COLUMN birthday TEXT',
    `UPDATE users SET birth_year = CAST(substr(date_of_birth, 1, 4) AS INTEGER), birth_month = CAST(substr(date_of_birth, 6, 2) AS INTEGER),
       birthday = substr(date_of_birth, 6, 5)
     WHERE date_of_birth GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]-[0-3][0-9]' AND CAST(substr(date_of_birth, 6, 2) AS INTEGER) BETWEEN 1 AND 12`,
    'ALTER TABLE users DROP COLUMN date_of_birth',
  ],
  14: [
    'ALTER TABLE household_members ADD COLUMN birth_month INTEGER CHECK (birth_month BETWEEN 1 AND 12)',
    'ALTER TABLE events ADD COLUMN out_of_state_fee_cents INTEGER CHECK (out_of_state_fee_cents >= 0)',
    'ALTER TABLE events ADD COLUMN student_fee_cents INTEGER CHECK (student_fee_cents >= 0)',
    'ALTER TABLE events ADD COLUMN child_free_age INTEGER CHECK (child_free_age >= 0)',
    "ALTER TABLE rsvps ADD COLUMN guest_types TEXT NOT NULL DEFAULT '{}'",
    // Guests registered before guest types were all at the one guest (in-state) price.
    `UPDATE rsvps SET guest_types = json_object('instate', guest_count) WHERE guest_count > 0`,
  ],
  12: ['ALTER TABLE rsvps ADD COLUMN pay_at_door INTEGER NOT NULL DEFAULT 0'],
  // SQLite can't change a CHECK in place, so payments is rebuilt with PayPal and Venmo allowed
  // (openDb turns foreign keys off around this, as SQLite's docs advise for rebuilding a table).
  13: [
    `CREATE TABLE payments_v13 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('membership', 'membership_upgrade', 'event', 'donation', 'other')),
      reference_id INTEGER,
      note TEXT,
      description TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled')),
      method TEXT CHECK (method IN ('stripe', 'paypal', 'venmo', 'demo', 'cash', 'check', 'other')),
      provider_ref TEXT,
      recorded_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      paid_at TEXT,
      refunded_at TEXT
    )`,
    `INSERT INTO payments_v13 (id, user_id, kind, reference_id, note, description, amount_cents, status, method,
       provider_ref, recorded_by, created_at, paid_at, refunded_at)
     SELECT id, user_id, kind, reference_id, note, description, amount_cents, status, method,
       provider_ref, recorded_by, created_at, paid_at, refunded_at FROM payments`,
    'DROP TABLE payments',
    'ALTER TABLE payments_v13 RENAME TO payments',
  ],
  4: ['ALTER TABLE users ADD COLUMN checkin_access INTEGER NOT NULL DEFAULT 0'],
  // rsvp_attendees itself is created by SCHEMA. Older RSVPs have no names and show a head count.
  5: [
    'ALTER TABLE users ADD COLUMN owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL',
    'ALTER TABLE household_members ADD COLUMN email TEXT COLLATE NOCASE',
    'ALTER TABLE household_members ADD COLUMN login_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL',
  ],
  7: ['ALTER TABLE payments ADD COLUMN refunded_at TEXT'],
  8: [
    'ALTER TABLE household_members ADD COLUMN invite_token TEXT',
    'ALTER TABLE household_members ADD COLUMN invite_expires TEXT',
  ],
  9: ['ALTER TABLE users ADD COLUMN theme TEXT'],
  10: [
    'ALTER TABLE users ADD COLUMN share_birthday INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE users ADD COLUMN anniversary TEXT',
    'ALTER TABLE users ADD COLUMN share_anniversary INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE household_members ADD COLUMN birthday TEXT',
    'ALTER TABLE household_members ADD COLUMN share_birthday INTEGER NOT NULL DEFAULT 0',
  ],
  11: [
    "ALTER TABLE users ADD COLUMN contact_type TEXT NOT NULL DEFAULT 'member'",
    'ALTER TABLE users ADD COLUMN contact_person TEXT',
    'ALTER TABLE users ADD COLUMN website TEXT',
    'ALTER TABLE users ADD COLUMN sponsor_level TEXT',
    'ALTER TABLE users ADD COLUMN sponsor_year INTEGER',
    'ALTER TABLE users ADD COLUMN show_on_website INTEGER NOT NULL DEFAULT 0',
    // Contacts tagged Sponsor or Vendor who aren't members (no login, no membership, not family or staff) become
    // sponsor/vendor contacts. Their name moves to the organization field until the committee types the business name.
    `UPDATE users SET contact_type = 'business', contact_person = trim(first_name || ' ' || last_name),
       first_name = trim(first_name || ' ' || last_name), last_name = ''
     WHERE (',' || tags || ',' LIKE '%,Sponsor,%' OR ',' || tags || ',' LIKE '%,Vendor,%')
       AND password_hash IS NULL AND role = 'member' AND owner_id IS NULL AND checkin_access = 0
       AND NOT EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id)`,
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
    // Rebuilding a table (v13) needs foreign keys off; they're checked again afterwards.
    const rebuild = version < 13;
    if (rebuild) db.exec('PRAGMA foreign_keys = OFF;');
    for (let v = version + 1; v <= SCHEMA_VERSION; v++) {
      transaction(db, () => (MIGRATIONS[v] || []).forEach((sql) => db.exec(sql)));
    }
    if (rebuild) {
      db.exec('PRAGMA foreign_keys = ON;');
      const broken = db.prepare('PRAGMA foreign_key_check').all();
      if (broken.length) throw new Error(`Database upgrade left ${broken.length} broken references: ${JSON.stringify(broken.slice(0, 3))}`);
    }
  }
  db.exec(SCHEMA);
  // Suggested news sources, added once (new databases and the upgrade to v10). The committee can change them.
  if (version < 10) require('./newsfeed').addDefaultSources(db);
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
