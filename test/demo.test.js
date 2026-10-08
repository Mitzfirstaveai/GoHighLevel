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
