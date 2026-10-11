// The admin area is strictly for admin work: no member profile, dues or tickets inside it,
// and the member app never links to it.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');

let t;
let admin;

before(async () => {
  t = await startTestApp();
  admin = await t.adminLogin();
});
after(() => t.close());

test('signed in to the admin area, member pages send the admin back to the admin area', async () => {
  const a = await t.adminLogin();
  for (const path of ['/dashboard', '/profile', '/membership', '/membership/pay', '/tickets', '/events', '/payments', '/more', '/donate']) {
    assert.equal((await a.get(path)).location, '/admin', path);
  }
  assert.equal((await a.get('/')).location, '/admin');
  const res = await a.get('/admin');
  assert.match(res.text, /class="subnav[ "]/);
  // Phones get the admin bottom bar (not the member one); "More" lists the other admin pages.
  const bar = res.text.split('<nav class="tabbar mobile-only admin-tabbar"')[1].split('</nav>')[0];
  assert.deepEqual([...bar.matchAll(/<span>([^<]+)<\/span>/g)].map((x) => x[1]), ['Overview', 'Check-in', 'Events', 'Members', 'More']);
  assert.match(res.text, /class="menu-compact desktop-only" aria-label="Admin"[^>]*data-compact-menu hidden/, 'slim pinned row on bigger screens');
  const more = await a.get('/admin/more');
  for (const page of ['Payments', 'Donations', 'Reports', 'Trends', 'Levels', 'News', 'Photos', 'Website']) assert.match(more.text, new RegExp(`<main[\\s\\S]*>\\s*${page}</a>`), page);
  assert.match((await a.get('/admin/reports')).text, /admin-tabbar"[\s\S]*?class="active" *href="\/admin\/more"|admin-tabbar"[\s\S]*?href="\/admin\/more" class="active"/, 'More is lit on its pages');
  assert.doesNotMatch(res.text, /href="\/profile"|href="\/membership"/, 'no member menu');
  assert.match(res.text, /<button class="pref-btn">Sign out<\/button>/);
  // The public information pages the committee edits can still be checked.
  assert.equal((await a.get('/about')).status, 200);
  // Signing out returns to the committee sign-in.
  assert.equal((await a.post('/logout')).location, '/admin/login');
});

test('an admin using the member sign-in gets a plain member app with no admin access', async () => {
  const m = await t.login('admin@test.org', 'Mango#Ledger2026');
  let res = await m.get('/dashboard');
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /href="\/admin"/, 'no Admin link in the member app');
  assert.match(res.text, /<button class="pref-btn">Sign out<\/button>/, 'Sign out is a worded button, not just an icon');
  assert.match(res.text, /class="menu-band member-menu/);
  assert.match(res.text, /class="menu-band member-menu[\s\S]*?href="\/donate"[^>]*>[\s\S]*?<span>Donate<\/span>/, 'Donate is in the main menu');
  assert.doesNotMatch(res.text, /class="subnav[ "]/);
  assert.equal((await m.get('/admin/checkin')).location, '/admin/login');
  res = await m.get('/admin/members');
  assert.equal(res.location, '/admin/login');

  // Committee sign-in from there opens the admin page they were heading to.
  res = await m.post('/admin/login', { email: 'admin@test.org', password: 'Mango#Ledger2026' });
  assert.equal(res.location, '/admin/members');
});

test("in the member app an admin sees only their own family's tickets and receipts", async () => {
  const eventId = await t.createEvent(admin, { title: 'Members Only' });
  const other = await t.register('other@test.org');
  await other.post(`/events/${eventId}/rsvp`, { party_size: '1' });
  const rsvp = t.rsvpFor(eventId, 'other@test.org');
  const otherId = t.db.prepare('SELECT id FROM users WHERE email = ?').get('other@test.org').id;
  const paymentId = Number(t.db.prepare(`INSERT INTO payments (user_id, kind, description, amount_cents, status, method, paid_at)
    VALUES (?, 'donation', 'Gift', 5000, 'paid', 'cash', datetime('now'))`).run(otherId).lastInsertRowid);

  const m = await t.login('admin@test.org', 'Mango#Ledger2026');
  assert.notEqual((await m.get(`/tickets/${rsvp.id}`)).status, 200);
  assert.equal((await m.get(`/receipts/${paymentId}`)).status, 404);
  // The admin area can still open any receipt.
  assert.equal((await admin.get(`/receipts/${paymentId}`)).status, 200);
  assert.equal((await other.get(`/receipts/${paymentId}`)).status, 200);
});

test('Overview shows the money collected this year, matching the Reports total', async () => {
  const admin = await t.adminLogin();
  const year = new Date().getFullYear();
  const u = t.db.prepare(`SELECT id FROM users WHERE email = 'admin@test.org'`).get().id;
  const pay = (cents, when) => t.db.prepare(`INSERT INTO payments (user_id, kind, description, amount_cents, status, method, paid_at)
    VALUES (?, 'donation', 'Gift', ?, 'paid', 'cash', ?)`).run(u, cents, when);
  pay(12345, `${year}-03-01 18:00:00`);
  pay(27500, `${year - 1}-06-01 18:00:00`); // last year: not counted
  const res = await admin.get('/admin');
  const reportTotal = (await admin.get(`/admin/reports?year=${year}`)).text.match(/Total income \d{4}<\/div><div class="value">([^<]+)</)?.[1];
  const shown = res.text.match(new RegExp(`Collected in ${year}</div><div class="value">([^<]+)<`))[1];
  assert.ok(reportTotal, 'the Reports total is shown');
  assert.equal(shown, reportTotal, 'Overview and Reports agree');
  assert.doesNotMatch(res.text, /Total collected/);
  const thisYear = t.db.prepare(`SELECT SUM(amount_cents) AS c FROM payments WHERE status = 'paid' AND substr(datetime(paid_at, 'localtime'), 1, 4) = ?`).get(String(year)).c;
  assert.equal(shown, `$${(thisYear / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`, "last year's $275 isn't counted");
});
