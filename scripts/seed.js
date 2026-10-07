// Populates the database with demo data: an admin, a few members, plans and events.
const bcrypt = require('bcryptjs');
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');

const config = loadConfig();
const db = openDb(config.databaseFile);

if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
  console.log('Database already has users — skipping seed.');
  process.exit(0);
}

const hash = bcrypt.hashSync('password123', 10);
const addUser = db.prepare(`INSERT INTO users (email, password_hash, role, first_name, last_name, phone, city, state, native_place)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
addUser.run('admin@example.com', hash, 'admin', 'Kiran', 'Patel', '501-555-0100', 'Little Rock', 'AR', 'Anand');
const members = [
  ['priya.shah@example.com', 'Priya', 'Shah', '501-555-0101', 'Conway', 'AR', 'Surat'],
  ['raj.desai@example.com', 'Raj', 'Desai', '479-555-0102', 'Bentonville', 'AR', 'Navsari'],
  ['meena.mehta@example.com', 'Meena', 'Mehta', '501-555-0103', 'North Little Rock', 'AR', 'Bhavnagar'],
];
for (const [email, first, last, phone, city, state, vatan] of members) {
  addUser.run(email, hash, 'member', first, last, phone, city, state, vatan);
}
db.prepare(`INSERT INTO household_members (user_id, name, relationship, birth_year) VALUES (2, 'Amit Shah', 'Spouse', 1984), (2, 'Diya Shah', 'Daughter', 2014)`).run();

// Gujarati Samaj of Arkansas membership levels (calendar year, renew manually).
db.prepare(`INSERT INTO membership_plans
  (name, description, amount_cents, duration_months, calendar_year, spouse_allowed, children_allowed, max_parents, min_age, sort_order)
  VALUES
  ('Senior Citizen', 'Per person, age 65 or older', 11000, 12, 1, 0, 0, 0, 65, 1),
  ('Individual Membership', 'One person aged 18 and over', 16500, 12, 1, 0, 0, 0, 18, 2),
  ('Married Couple', 'Married couple excluding children and parents', 27500, 12, 1, 1, 0, 0, 0, 3),
  ('Family', 'Married couple (or single parent) with their unmarried children', 33000, 12, 1, 1, 1, 0, 0, 4),
  ('Family with Parents', 'Married couple (or single parent) with their unmarried children, and one set of parents to be noted at renewal', 38500, 12, 1, 1, 1, 2, 0, 5)
`).run();
// Priya already has a Family membership for this year.
const year = new Date().getFullYear();
db.prepare(`INSERT INTO memberships (user_id, plan_id, start_date, end_date) VALUES (2, 4, ?, ?)`).run(`${year}-01-01`, `${year}-12-31`);

const inDays = (n, time) => {
  const d = new Date(Date.now() + n * 86400000);
  return `${d.toISOString().slice(0, 10)}T${time}`;
};
const addEvent = db.prepare(`INSERT INTO events (title, description, location, starts_at, ends_at, fee_cents, capacity, max_party_size, created_by)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`);
addEvent.run('Navratri Garba Night', 'Join us for an evening of garba and dandiya raas with live music. Dinner included.',
  'Hindu Temple of Central Arkansas, Little Rock', inDays(10, '19:00'), inDays(10, '23:30'), 1500, 400, 8);
addEvent.run('Diwali Sneh Milan', 'Celebrate the new year together with prayers, cultural program and dinner.',
  'Statehouse Convention Center, Little Rock', inDays(30, '17:00'), inDays(30, '21:00'), 0, null, 10);
addEvent.run('Youth Cricket Tournament', 'Teams of all ages welcome. Lunch provided for registered players.',
  'Burns Park, North Little Rock', inDays(45, '09:00'), null, 1000, 120, 4);

console.log('Seeded demo data. Sign in as admin@example.com / password123 (members use the same password).');
