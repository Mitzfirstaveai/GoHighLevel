const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');

let t;

before(async () => {
  t = await startTestApp({ demoMode: true, adminEmail: '' });
});

after(() => t.close());

test('demo mode fills an empty database and offers one-tap sign-in', async () => {
  const { db } = t;
  assert.ok(db.prepare('SELECT COUNT(*) AS n FROM users').get().n >= 10);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM membership_plans').get().n, 5);
  const c = new t.Client();
  let res = await c.get('/login');
  assert.doesNotMatch(res.text, /Admin \(committee\)/, 'the admin demo button is only on the committee sign-in');
  assert.match(res.text, /Member \(Family level\)/);
  res = await c.get('/admin/login');
  assert.match(res.text, /Admin \(committee\)/);

  // The demo button signs the admin in.
  res = await c.post('/admin/login', { email: 'admin@example.com', password: 'demo1234' });
  assert.equal(res.status, 302);
  res = await c.get('/admin');
  assert.match(res.text, /Reset demo data/);

  // Change something, then reset brings the sample data back.
  const eventCount = db.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  db.prepare('DELETE FROM events').run();
  res = await c.post('/admin/demo/reset');
  assert.equal(res.status, 302);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, eventCount);
  res = await c.get('/admin');
  assert.match(res.text, /Demo data has been reset/);
});

test("the demo's Admin and Door volunteer buttons keep working, whatever is changed during a demo", async () => {
  const admin = await t.adminLogin('admin@example.com', 'demo1234');
  const id = (email) => t.db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
  const dhruv = id('dhruv.amin@example.com');
  let res = await admin.follow(await admin.post(`/admin/members/${dhruv}/checkin-access`, { access: '0', return_to: '/admin/checkin' }));
  assert.match(res.text, /behind the &#34;Door volunteer&#34; demo sign-in button/);
  await admin.post(`/admin/members/${dhruv}/role`, { role: 'admin' });
  const row = t.db.prepare('SELECT role, checkin_access FROM users WHERE id = ?').get(dhruv);
  assert.deepEqual({ ...row }, { role: 'member', checkin_access: 1 });
  const door = new t.Client();
  await door.get('/admin/login');
  assert.equal((await door.post('/admin/login', { email: 'dhruv.amin@example.com', password: 'demo1234' })).location, '/admin/checkin');

  // Other members can still be given and refused door access to show the feature.
  const priya = id('member@example.com');
  await admin.post(`/admin/members/${priya}/checkin-access`, { access: '1' });
  await admin.post(`/admin/members/${priya}/checkin-access`, { access: '0' });
  assert.equal(t.db.prepare('SELECT checkin_access FROM users WHERE id = ?').get(priya).checkin_access, 0);
});

test('the home page lists what members get as plain text, and the demo note points to both sign-ins', async () => {
  const res = await new t.Client().get('/');
  assert.match(res.text, /<section class="perks">/);
  assert.doesNotMatch(res.text, /<div class="card"><h2>📇/, 'no boxes that look like tabs');
  assert.match(res.text, /try it as a member, or &#34;Committee &amp; volunteer sign-in&#34; at the bottom of the page/);
});

test('resetting the demo puts every browser back to dark, English, normal text', async () => {
  const phone = new t.Client(); // e.g. the presenter's phone, signed out, set to Light + Gujarati
  await phone.get('/prefs?theme=light&lang=gu&size=large&back=/');
  assert.match((await phone.get('/login')).text, /<html lang="gu" class="size-large" data-theme="light">/);

  const admin = await t.adminLogin('admin@example.com', 'demo1234');
  await admin.get('/prefs?theme=light&back=/admin');
  await admin.post('/admin/demo/reset');
  assert.match((await admin.get('/admin')).text, /data-theme="dark"/);
  assert.match((await phone.get('/login')).text, /<html lang="en" class="size-normal" data-theme="dark">/);

  // Choices made after the reset stick as usual.
  await phone.get('/prefs?theme=light&back=/');
  assert.match((await phone.get('/login')).text, /data-theme="light"/);
});

test("the demo has a Garba night today: tickets, money due at the door, and RSVPs still open", async () => {
  const { db } = t;
  const svc = require('../src/services');
  const { nowLocal } = require('../src/util');
  const ev = db.prepare(`SELECT * FROM events WHERE title = 'Navratri Garba — Tonight'`).get();
  assert.ok(ev, 'tonight’s Garba exists');
  assert.equal(ev.starts_at.slice(0, 10), nowLocal().slice(0, 10), 'it is today');
  assert.deepEqual([ev.fee_cents, ev.child_free_age, ev.title_gu], [500, 10, 'નવરાત્રી ગરબા — આજે રાત્રે']);
  if (nowLocal().slice(11, 16) < '23:30') assert.ok(svc.rsvpWindowOpen(ev), 'RSVPs are open until it starts');

  // Priya (the demo member) has paid for no event, so she can RSVP & Pay for tonight from the start;
  // once she has, her Home turns green with tonight's ticket.
  const priyaId = db.prepare(`SELECT id FROM users WHERE email = 'member@example.com'`).get().id;
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE kind = 'event' AND user_id = ?`).get(priyaId).n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM rsvps r JOIN events e ON e.id = r.event_id WHERE r.user_id = ? AND e.starts_at >= ?`).get(priyaId, nowLocal()).n, 0);
  const m = new t.Client();
  await m.get('/login');
  await m.post('/login', { email: 'member@example.com', password: 'demo1234' });
  let res = await m.get(`/events/${ev.id}`);
  assert.match(res.text, /RSVP &amp; Pay/);
  res = await m.post(`/events/${ev.id}/rsvp`, { choose: '1', people: `u:${priyaId}`, pay: 'online' });
  await m.post(res.location, { method: 'demo' });
  assert.match((await m.get('/dashboard')).text, /next-event today[\s\S]*Navratri Garba — Tonight/);

  // At the door, the Joshis owe $55 tonight, with no "not today" warning.
  const joshi = db.prepare(`SELECT r.qr_token FROM rsvps r JOIN users u ON u.id = r.user_id WHERE u.email = 'nilesh.joshi@example.com' AND r.event_id = ?`).get(ev.id);
  const door = new t.Client();
  await door.get('/admin/login');
  await door.post('/admin/login', { email: 'dhruv.amin@example.com', password: 'demo1234' });
  res = await door.get(`/admin/checkin/${joshi.qr_token}`);
  assert.match(res.text, /\$55\.00 DUE/);
  assert.doesNotMatch(res.text, /not today/);
});
