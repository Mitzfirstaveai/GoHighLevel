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

db.prepare(`INSERT INTO membership_plans (name, description, amount_cents, duration_months) VALUES
  ('Annual Family Membership', 'Covers the member and their household', 5100, 12),
  ('Annual Individual Membership', 'Single adult', 2500, 12),
  ('Life Membership', 'One-time payment', 50100, 1200)`).run();

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
