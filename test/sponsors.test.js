// Sponsors & vendors: kept apart from members in the admin area, and the source of the public Sponsors page.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');
const { SPONSORS } = require('../src/content');

let t;
let admin;

before(async () => {
  t = await startTestApp();
  admin = await t.adminLogin();
});
after(() => t.close());

const byName = (name) => t.db.prepare('SELECT * FROM users WHERE first_name = ?').get(name);

test("the website's existing sponsor list becomes sponsor contacts, shown on the Sponsors page", async () => {
  for (const name of SPONSORS.flatMap((s) => s.names)) {
    const b = byName(name);
    assert.equal(b.contact_type, 'business', name);
    assert.equal(b.show_on_website, 1);
  }
  const res = await new t.Client().get('/sponsors');
  assert.match(res.text, new RegExp(`tier-platinum">Platinum</span> Level[\\s\\S]*?${SPONSORS[0].names[0]}`));
});

test('sponsors and vendors have their own tab and stay out of member lists and counts', async () => {
  let res = await admin.follow(await admin.post('/admin/members/new', {
    contact_type: 'business', organization: 'Patel Motel Group', contact_person: 'Ravi Patel', email: 'ravi@patelmotels.example.com',
    website: 'patelmotels.example.com', tags: ['Sponsor'], sponsor_level: 'Silver', sponsor_year: '2026', show_on_website: '1',
  }));
  assert.match(res.text, /<h1>Patel Motel Group<\/h1>/);
  assert.match(res.text, /Silver 2026/);
  const motel = byName('Patel Motel Group');
  assert.deepEqual([motel.last_name, motel.contact_person, motel.website], ['', 'Ravi Patel', 'https://patelmotels.example.com']);

  res = await admin.get('/admin/members?type=business');
  assert.match(res.text, /class="active">Sponsors &amp; vendors \(\d+\)/);
  assert.match(res.text, /Patel Motel Group[\s\S]*?Ravi Patel/);
  res = await admin.get('/admin/members');
  assert.match(res.text, /class="active">Members \(\d+\)/);
  assert.doesNotMatch(res.text, /Patel Motel Group/);
  assert.doesNotMatch((await admin.get('/admin/members.csv')).text, /Patel Motel Group/);
  assert.match((await admin.get('/admin/members.csv?type=business')).text, /Patel Motel Group,Ravi Patel,ravi@patelmotels\.example\.com/);

  const members = t.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE contact_type = 'member'`).get().n;
  assert.match((await admin.get('/admin')).text, new RegExp(`Registered members</div>\\s*<div class="value">${members}<`));
  const m = await t.register('dirmember@test.org', 'Dir');
  assert.doesNotMatch((await m.get('/directory')).text, /Patel Motel Group/);
});

test('a sponsorship payment gets a receipt in the business name; no memberships for businesses', async () => {
  const motel = byName('Patel Motel Group');
  let res = await admin.follow(await admin.post(`/admin/members/${motel.id}/payments`, { kind: 'donation', amount: '1000', method: 'check', reference: '1042', description: 'Silver sponsorship 2026' }));
  const pay = t.db.prepare(`SELECT id FROM payments WHERE user_id = ? AND status = 'paid'`).get(motel.id);
  res = await admin.get(`/receipts/${pay.id}`);
  assert.match(res.text, /Received from[\s\S]*?<strong>Patel Motel Group <\/strong>|Received from[\s\S]*?<strong>Patel Motel Group<\/strong>/);
  const plan = t.db.prepare('SELECT id FROM membership_plans LIMIT 1').get().id;
  res = await admin.follow(await admin.post(`/admin/members/${motel.id}/payments`, { kind: 'membership', plan_id: String(plan), method: 'cash' }));
  assert.match(res.text, /don&#39;t have memberships/);
});

test('contacts can be moved between Members and Sponsors & vendors (not members who sign in)', async () => {
  await admin.post('/admin/members/new', { first_name: 'Shreeji', last_name: 'Caterers', tags: 'Vendor' });
  const v = byName('Shreeji');
  await admin.post(`/admin/members/${v.id}/contact-type`, { type: 'business' });
  let row = t.db.prepare('SELECT * FROM users WHERE id = ?').get(v.id);
  assert.deepEqual([row.contact_type, row.first_name, row.last_name], ['business', 'Shreeji Caterers', '']);
  await admin.post(`/admin/members/${v.id}/contact-type`, { type: 'member' });
  row = t.db.prepare('SELECT * FROM users WHERE id = ?').get(v.id);
  assert.deepEqual([row.contact_type, row.first_name, row.last_name], ['member', 'Shreeji', 'Caterers']);

  await t.register('signsin@test.org', 'Signs');
  const s = t.db.prepare(`SELECT id FROM users WHERE email = 'signsin@test.org'`).get();
  const res = await admin.follow(await admin.post(`/admin/members/${s.id}/contact-type`, { type: 'business' }));
  assert.match(res.text, /signs in to the member app/);
  assert.equal(t.db.prepare('SELECT contact_type FROM users WHERE id = ?').get(s.id).contact_type, 'member');
});

test('upgrading: contacts tagged Sponsor/Vendor without a membership move over; members who sponsor stay', () => {
  const { DatabaseSync } = require('node:sqlite');
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsa-mig-'));
  const file = path.join(dir, 'old.db');
  // A version-10 database with two sponsors: one plain contact, one who is also a paid member.
  const { openDb } = require('../src/db');
  openDb(file).close();
  const raw = new DatabaseSync(file);
  for (const col of ['contact_type', 'contact_person', 'website', 'sponsor_level', 'sponsor_year', 'show_on_website']) raw.exec(`ALTER TABLE users DROP COLUMN ${col}`);
  require('./helpers').rewindSchema(raw, 10);
  raw.exec(`INSERT INTO users (first_name, last_name, tags) VALUES ('Laura', 'Mitchell', 'Sponsor'), ('Nita', 'Desai', 'Sponsor,Donor')`);
  raw.exec(`INSERT INTO membership_plans (name, amount_cents, duration_months) VALUES ('Family', 33000, 12)`);
  raw.exec(`INSERT INTO memberships (user_id, plan_id, start_date, end_date) VALUES ((SELECT id FROM users WHERE first_name = 'Nita'), 1, '2026-01-01', '2026-12-31')`);
  raw.close();
  const db = openDb(file);
  const laura = db.prepare(`SELECT * FROM users WHERE contact_person = 'Laura Mitchell'`).get();
  assert.deepEqual([laura.contact_type, laura.first_name, laura.last_name], ['business', 'Laura Mitchell', '']);
  assert.equal(db.prepare(`SELECT contact_type FROM users WHERE first_name = 'Nita'`).get().contact_type, 'member');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
