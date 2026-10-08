// Regression tests for issues found in the app review.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');
const { grantMembership, upgradeMembership } = require('../src/services');
const { localDate } = require('../src/util');

let t;
let admin;

before(async () => {
  t = await startTestApp();
  admin = await t.adminLogin();
});
after(() => t.close());

const userId = (email) => t.db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

test('a waitlisted ticket is not shown as valid at the door and gives the right message', async () => {
  const eventId = await t.createEvent(admin, { title: 'Full House', capacity: '1' });
  const a = await t.register('fa@test.org');
  const b = await t.register('fb@test.org');
  await a.post(`/events/${eventId}/rsvp`, { party_size: '1' });
  await b.post(`/events/${eventId}/rsvp`, { party_size: '1', waitlist: '1' });
  const token = t.rsvpFor(eventId, 'fb@test.org').qr_token;
  let res = await admin.get(`/admin/checkin/${token}`);
  assert.match(res.text, /On the waitlist — no seat yet/);
  assert.doesNotMatch(res.text, /Valid ticket/);
  assert.doesNotMatch(res.text, /name="guests"/);
  res = await admin.follow(await admin.post(`/admin/checkin/${token}`, { guests: '1' }));
  assert.match(res.text, /on the waitlist and has no seat yet/);
  assert.doesNotMatch(res.text, /already been used/);
});

test('scanning a ticket for another day warns the volunteer', async () => {
  const eventId = await t.createEvent(admin, { title: 'Next Week Event' }); // 10 days away
  const m = await t.register('wrongday@test.org');
  await m.post(`/events/${eventId}/rsvp`, { party_size: '1' });
  const res = await admin.get(`/admin/checkin/${t.rsvpFor(eventId, 'wrongday@test.org').qr_token}`);
  assert.match(res.text, /Check the event:/);
  assert.match(res.text, /not today/);
});

test('late-evening payments are dated and reported in local time', async () => {
  // 11:30 pm Central on Dec 31 is 05:30 UTC on Jan 1.
  const stamp = '2027-01-01 05:30:00';
  assert.equal(localDate(stamp), '2026-12-31');
  await t.register('nye@test.org', 'Nina');
  const pid = Number(t.db.prepare(`INSERT INTO payments (user_id, kind, description, amount_cents, status, method, paid_at)
    VALUES (?, 'donation', 'Donation — General fund', 50100, 'paid', 'check', ?)`).run(userId('nye@test.org'), stamp).lastInsertRowid);
  const m = await t.login('nye@test.org', 'secret123');
  let res = await m.get(`/receipts/${pid}`);
  assert.match(res.text, /Dec 31, 2026/);
  res = await admin.get('/admin/reports/quickbooks.csv?year=2026');
  assert.match(res.text, /12\/31\/2026,Sales Receipt/);
  res = await admin.get('/admin/donations.csv?from=2026-12-31&to=2026-12-31');
  assert.match(res.text, /2026-12-31,Nina/);
});

test('an upgraded member is counted once in trends', async () => {
  await t.register('upg@test.org', 'Uma');
  const uid = userId('upg@test.org');
  grantMembership(t.db, { userId: uid, planId: t.planId('Married Couple') });
  upgradeMembership(t.db, { userId: uid, planId: t.planId('Family') });
  const res = await admin.get('/admin/insights');
  const table = res.text.slice(res.text.indexOf('Active memberships by level'));
  assert.doesNotMatch(table.slice(0, table.indexOf('</figure>')), /Married Couple/);
  assert.match(table, /Family/);
});

test('repeated wrong passwords pause sign-in for that email', async () => {
  await t.register('guess@test.org');
  const c = new t.Client();
  await c.get('/login');
  for (let i = 0; i < 8; i++) assert.equal((await c.post('/login', { email: 'guess@test.org', password: 'wrong' })).status, 401);
  const res = await c.post('/login', { email: 'guess@test.org', password: 'secret123' });
  assert.equal(res.status, 429);
  assert.match(res.text, /Too many attempts/);
});

test('active members stay signed in (session is extended on each visit)', async () => {
  const m = await t.register('stay@test.org');
  const res = await fetch(`${t.base}/dashboard`, { headers: { cookie: m.cookie } });
  assert.match(res.headers.getSetCookie().join(';'), /connect\.sid=.*Expires=/);
});

test('security headers: no embedding, camera only for this site', async () => {
  const res = await new t.Client().get('/login');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(res.headers.get('permissions-policy'), /camera=\(self\)/);
  assert.match(res.headers.get('permissions-policy'), /microphone=\(\)/);
});

test('stylesheet and script addresses change with the file, so phones never keep an old copy', async () => {
  const fs = require('node:fs');
  const crypto = require('node:crypto');
  const css = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'styles.css'));
  const v = crypto.createHash('sha1').update(css).digest('hex').slice(0, 10);
  const res = await new t.Client().get('/login');
  assert.match(res.text, new RegExp(`<link rel="stylesheet" href="/styles\\.css\\?v=${v}">`));
  assert.match(res.text, /<script src="\/app\.js\?v=[0-9a-f]{10}" defer>/);
  const file = await fetch(`${t.base}/styles.css?v=${v}`);
  assert.equal(file.status, 200);
});
