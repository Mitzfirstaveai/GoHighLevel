// Fixes from the full phone/laptop check: readable calendar on phones, same-day event times, plan wording.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');
const { grantMembership } = require('../src/services');

let t;
let admin;

before(async () => {
  t = await startTestApp();
  admin = await t.adminLogin();
});
after(() => t.close());

test("the calendar lists the month's events in full for phones, with 12-hour times", async () => {
  const starts = t.futureDate(3, '19:30');
  const id = await t.createEvent(admin, { title: 'Sharad Purnima Garba', starts_at: starts, ends_at: starts.replace('19:30', '23:00') });
  const m = await t.register('calendar@test.org');
  const res = await m.get(`/events?view=calendar&month=${starts.slice(0, 7)}`);
  assert.match(res.text, /class="cal-event[^"]*"[^>]*>7:30 PM Sharad Purnima Garba</);
  assert.match(res.text, new RegExp(`<div class="cal-list event-list">[\\s\\S]*?href="/events/${id}"[\\s\\S]*?Sharad Purnima Garba[\\s\\S]*?7:30 PM`));

  // Same-day events show the end time only: "7:30 PM – 11:00 PM".
  const page = await m.get(`/events/${id}`);
  assert.match(page.text, /When:<\/strong> [^<]*7:30 PM – 11:00 PM<\/p>/);
});

test('a level named "... Membership" is not doubled in messages ("Your Individual membership covers…")', async () => {
  t.db.prepare(`UPDATE membership_plans SET name = 'Individual Membership' WHERE name = 'Individual'`).run();
  const m = await t.register('solo@test.org', 'Solo');
  const id = t.db.prepare(`SELECT id FROM users WHERE email = 'solo@test.org'`).get().id;
  grantMembership(t.db, { userId: id, planId: t.planId('Individual Membership') });
  const res = await m.follow(await m.post('/profile/household', { name: 'Asha', relationship: 'Spouse', birth_month: '4', birth_year: '1980' }));
  assert.match(res.text, /Your Individual membership covers you only, so Asha can&#39;t be added/);
  assert.match((await m.get('/profile')).text, /Your Individual membership covers you only\./);
});

test('the phone bottom bar uses the top menu names and includes Donate', async () => {
  const m = await t.register('bottombar@test.org');
  const res = await m.get('/donate');
  const bar = res.text.split('<nav class="tabbar')[1].split('</nav>')[0];
  const labels = [...bar.matchAll(/<span>([^<]+)<\/span>/g)].map((x) => x[1].replace('\u00AD', ''));
  assert.deepEqual(labels, ['Home', 'Events', 'My tickets', 'Membership', 'Donate', 'More']);
  assert.match(bar, /class="active"[^>]*>[\s\S]*?<span>Donate<\/span>/);
  // Donate has its own button, so the More page doesn't list it again.
  const more = (await m.get('/more')).text;
  assert.doesNotMatch(more.slice(more.indexOf('<main'), more.indexOf('</main>')), /href="\/donate"/);
});

test('tickets show a short code the door can type when the QR code will not scan', async () => {
  const { shortCode } = require('../src/services');
  const eventId = await t.createEvent(admin, { title: 'Sharad Purnima', starts_at: t.futureDate(2) });
  const m = await t.register('shortcode@test.org', 'Short', 3);
  await m.post(`/events/${eventId}/rsvp`, { party_size: '4' });
  const before = t.rsvpFor(eventId, 'shortcode@test.org');
  const code = shortCode(before.qr_token);
  assert.match(code, /^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/, 'no 0/O or 1/I/L');
  assert.match((await m.get(`/tickets/${before.id}`)).text, new RegExp(`<p class="ticket-code">Ticket code <strong>${code}</strong></p>`));

  // The downloaded QR image has the code underneath it too (a 150px band below the 600px QR code).
  const png = await fetch(`${t.base}/tickets/${before.id}/qr.png`, { headers: { cookie: m.cookie } });
  assert.equal(png.headers.get('content-type'), 'image/png');
  const sharp = require('sharp');
  const img = sharp(Buffer.from(await png.arrayBuffer()));
  assert.deepEqual([(await img.metadata()).width, (await img.metadata()).height], [600, 750]);
  const band = await img.extract({ left: 0, top: 640, width: 600, height: 110 }).stats();
  assert.ok(band.channels[0].min < 50, 'dark code letters drawn below the QR code');

  // Typed at the door: any case, with or without the dash.
  for (const typed of [code, code.toLowerCase(), code.replace('-', ''), ` ${code.replace('-', ' ')} `]) {
    const res = await admin.post('/admin/checkin/lookup', { code: typed });
    assert.equal(res.location, `/admin/checkin/${before.qr_token}`, typed);
  }

  // Changing who's coming gives a new QR code and a new short code; the old one shows as replaced.
  await m.post(`/events/${eventId}/rsvp`, { party_size: '2' });
  const after = t.rsvpFor(eventId, 'shortcode@test.org');
  assert.notEqual(shortCode(after.qr_token), code);
  let res = await admin.follow(await admin.post('/admin/checkin/lookup', { code }));
  assert.match(res.text, /Old QR code — replaced/);
  res = await admin.post('/admin/checkin/lookup', { code: shortCode(after.qr_token) });
  assert.equal(res.location, `/admin/checkin/${after.qr_token}`);

  res = await admin.follow(await admin.post('/admin/checkin/lookup', { code: 'ZZZ-ZZZ' }));
  assert.match(res.text, /No ticket with code ZZZ-ZZZ for this week&#39;s events/);
});

test('the install card has steps for iPhone/iPad, Mac Safari and other browsers, and an Install button', async () => {
  const m = await t.register('install@test.org');
  const card = (await m.get('/dashboard')).text.split('id="install-card"')[1].split('</div>\n<div class="home-top">')[0];
  for (const kind of ['ios', 'mac', 'other']) assert.match(card, new RegExp(`data-steps="${kind}" hidden`), kind);
  assert.match(card, /On iPhone or iPad: tap the Share button/);
  assert.match(card, /private or incognito window/);
  assert.match(card, /<button class="btn small" data-install>Install<\/button>/, 'Install is always there (app.js decides what it does)');

  // Also before signing in: on the member sign-in and the committee & volunteer sign-in.
  const visitor = new t.Client();
  assert.match((await visitor.get('/login')).text, /id="install-card"[\s\S]*your QR tickets work even without signal[\s\S]*<h1[^>]*>Sign in<\/h1>/);
  assert.match((await visitor.get('/admin/login')).text, /id="install-card"[\s\S]*opens straight to the admin area or door check-in[\s\S]*data-steps="ios"/);

  // Home can be closed (it comes back after 30 days); More always offers it, with no ✕.
  assert.match(card, /data-dismiss/);
  const more = (await m.get('/more')).text;
  assert.match(more, /id="install-card" hidden data-always[\s\S]*Get the GSA app[\s\S]*data-install/);
  assert.doesNotMatch(more, /data-dismiss/);
  const adminMore = (await (await t.adminLogin()).get('/admin/more')).text;
  assert.match(adminMore, /id="install-card" hidden data-always[\s\S]*opens straight to the admin area/);
  assert.doesNotMatch(adminMore, /data-dismiss/);
});

test('checkout offers card, PayPal and Venmo; the choice shows on the receipt, at the door and in QuickBooks', async () => {
  const eventId = await t.createEvent(admin, { title: 'Venmo Night', fee: '20', starts_at: t.futureDate(1) });
  const m = await t.register('venmo@test.org', 'Ven');
  let res = await m.post(`/events/${eventId}/rsvp`, { party_size: '1', pay: 'online' });
  const page = await m.get(res.location);
  assert.match(page.text, /How would you like to pay\?[\s\S]*value="demo"[^>]*>💳 Card, Apple Pay, Google Pay or Cash App Pay[\s\S]*value="paypal"[\s\S]*value="venmo"/);
  res = await m.post(res.location, { method: 'venmo' });
  const rsvp = t.rsvpFor(eventId, 'venmo@test.org');
  assert.equal(rsvp.status, 'confirmed');
  const pay = t.db.prepare(`SELECT * FROM payments WHERE kind = 'event' AND reference_id = ? AND status = 'paid'`).get(rsvp.id);
  assert.equal(pay.method, 'venmo');
  assert.match((await m.get(`/receipts/${pay.id}`)).text, /Payment method<\/span><br><strong>Venmo/);
  assert.match((await admin.get(`/admin/checkin/${rsvp.qr_token}`)).text, /\$20\.00 paid \(Venmo\)/);
  assert.match((await admin.get(`/admin/reports/quickbooks.csv?year=${new Date().getFullYear()}`)).text, /Venmo Night — 1 person,Venmo,/);

  // PayPal works the same way (e.g. a donation).
  res = await m.post('/donate', { amount: '2500' });
  await m.post(res.location, { method: 'paypal' });
  assert.equal(t.db.prepare(`SELECT method FROM payments WHERE kind = 'donation' AND user_id = ? AND status = 'paid'`).get(pay.user_id).method, 'paypal');
});

test('upgrading to v13 keeps every payment and the memberships that point at them', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const { openDb } = require('../src/db');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsa-v13-'));
  const file = path.join(dir, 'old.db');
  let db = openDb(file);
  const uid = Number(db.prepare(`INSERT INTO users (first_name, last_name) VALUES ('Old', 'Payer')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO membership_plans (name, amount_cents, duration_months) VALUES ('Family', 33000, 12)`).run();
  const pid = Number(db.prepare(`INSERT INTO payments (user_id, kind, reference_id, description, amount_cents, status, method, paid_at)
    VALUES (?, 'membership', 1, 'Dues', 33000, 'paid', 'cash', datetime('now'))`).run(uid).lastInsertRowid);
  db.prepare(`INSERT INTO memberships (user_id, plan_id, start_date, end_date, payment_id) VALUES (?, 1, '2026-01-01', '2026-12-31', ?)`).run(uid, pid);
  db.close();
  const raw = new DatabaseSync(file);
  require('./helpers').rewindSchema(raw, 12);
  raw.close();
  db = openDb(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 19);
  assert.equal(db.prepare('SELECT method FROM payments WHERE id = ?').get(pid).method, 'cash');
  assert.equal(db.prepare('SELECT payment_id FROM memberships WHERE user_id = ?').get(uid).payment_id, pid);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.prepare(`INSERT INTO payments (user_id, kind, description, amount_cents, status, method) VALUES (?, 'donation', 'Gift', 500, 'paid', 'venmo')`).run(uid);
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('upgrading to v15 turns a full date of birth into birth month and year, keeping the day for Celebrations', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const { openDb } = require('../src/db');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsa-v15-'));
  const file = path.join(dir, 'old.db');
  let db = openDb(file);
  const add = (first) => Number(db.prepare(`INSERT INTO users (first_name, last_name) VALUES (?, 'Old')`).run(first).lastInsertRowid);
  const [withDob, without, odd] = [add('Dob'), add('NoDob'), add('Odd')];
  db.close();
  const raw = new DatabaseSync(file);
  require('./helpers').rewindSchema(raw, 14);
  raw.prepare("UPDATE users SET date_of_birth = '1975-04-12', share_birthday = 1 WHERE id = ?").run(withDob);
  raw.prepare("UPDATE users SET date_of_birth = 'sometime' WHERE id = ?").run(odd);
  raw.close();
  db = openDb(file);
  const row = (id) => ({ ...db.prepare('SELECT birth_year, birth_month, birthday, share_birthday FROM users WHERE id = ?').get(id) });
  assert.deepEqual(row(withDob), { birth_year: 1975, birth_month: 4, birthday: '04-12', share_birthday: 1 });
  assert.deepEqual(row(without), { birth_year: null, birth_month: null, birthday: null, share_birthday: 0 });
  assert.deepEqual(row(odd), { birth_year: null, birth_month: null, birthday: null, share_birthday: 0 });
  assert.ok(!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'date_of_birth'));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
