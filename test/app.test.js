const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');

let server;
let base;
let db;

before(async () => {
  const app = createApp(loadConfig({
    databaseFile: ':memory:', adminEmail: 'admin@test.org', adminPassword: 'adminpass1',
    stripeSecretKey: '', allowDemoPayments: true, baseUrl: 'http://test.local', orgName: 'Test Samaj',
  }));
  db = app.locals.db;
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

// Tiny cookie-keeping browser that knows how to fill in the CSRF token.
class Client {
  constructor() { this.cookie = ''; this.csrf = ''; }

  async request(method, path, form) {
    const headers = { cookie: this.cookie };
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams({ _csrf: this.csrf, ...form }).toString();
    }
    const res = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    const m = text.match(/name="_csrf" value="([^"]+)"/);
    if (m) this.csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
  }

  get(path) { return this.request('GET', path); }

  async post(path, form = {}) {
    if (!this.csrf) await this.get('/login');
    return this.request('POST', path, form);
  }

  async follow(res) {
    let r = res;
    while (r.location) r = await this.get(r.location);
    return r;
  }
}

async function login(email, password) {
  const c = new Client();
  await c.get('/login');
  const res = await c.post('/login', { email, password });
  assert.equal(res.status, 302, 'login should redirect');
  await c.get('/dashboard'); // refresh CSRF token for the new session
  return c;
}

async function register(email, first = 'Test') {
  const c = new Client();
  await c.get('/register');
  const res = await c.post('/register', {
    email, password: 'secret123', password_confirm: 'secret123', first_name: first, last_name: 'Member',
  });
  assert.equal(res.status, 302);
  await c.get('/profile');
  return c;
}

function futureDate(days, time = '18:00') {
  const d = new Date(Date.now() + days * 86400000);
  return `${d.toISOString().slice(0, 10)}T${time}`;
}

async function createEvent(admin, fields) {
  const res = await admin.post('/admin/events', {
    title: 'Garba Night', starts_at: futureDate(10), fee: '0', max_party_size: '6', status: 'published', ...fields,
  });
  assert.equal(res.status, 302);
  return Number(res.location.split('/').pop());
}

function rsvpFor(eventId, email) {
  return db.prepare(`SELECT r.* FROM rsvps r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND u.email = ?`)
    .get(eventId, email);
}

test('pages require sign-in and admin area requires admin', async () => {
  const anon = new Client();
  assert.equal((await anon.get('/dashboard')).location, '/login');
  const member = await register('nonadmin@test.org');
  assert.equal((await member.get('/admin')).status, 403);
  assert.equal((await member.get('/admin/members')).status, 403);
});

test('forms without a valid CSRF token are rejected', async () => {
  const member = await register('csrf@test.org');
  member.csrf = 'wrong';
  const res = await member.post('/profile', { first_name: 'X', last_name: 'Y' });
  assert.equal(res.status, 403);
});

test('member edits profile and family; admin sees the details', async () => {
  const member = await register('priya@test.org', 'Priya');
  let res = await member.post('/profile', {
    first_name: 'Priya', last_name: 'Shah', phone: '555-1234', city: 'Edison', state: 'NJ', native_place: 'Surat',
  });
  assert.equal(res.status, 302);
  await member.post('/profile/household', { name: 'Diya Shah', relationship: 'Daughter', birth_year: '2014' });

  const admin = await login('admin@test.org', 'adminpass1');
  res = await admin.get('/admin/members?q=Surat');
  assert.match(res.text, /Shah, Priya/);
  const id = db.prepare(`SELECT id FROM users WHERE email = 'priya@test.org'`).get().id;
  res = await admin.get(`/admin/members/${id}`);
  assert.match(res.text, /555-1234/);
  assert.match(res.text, /Diya Shah/);
  res = await admin.get('/admin/members.csv');
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.text, /Priya,Shah,priya@test\.org,555-1234/);
  assert.match(res.text, /Diya Shah \(Daughter\)/);
});

test('free event: RSVP gives a QR ticket, admin sees headcount, QR checks in only once', async () => {
  const admin = await login('admin@test.org', 'adminpass1');
  const eventId = await createEvent(admin, { title: 'Diwali Sneh Milan' });

  const member = await register('raj@test.org', 'Raj');
  let res = await member.post(`/events/${eventId}/rsvp`, { party_size: '4' });
  assert.match(res.location, /^\/tickets\/\d+$/);
  res = await member.get(res.location);
  assert.match(res.text, /data:image\/png;base64/);
  assert.match(res.text, /people registered/);

  const rsvp = rsvpFor(eventId, 'raj@test.org');
  assert.equal(rsvp.status, 'confirmed');
  assert.equal(rsvp.party_size, 4);

  res = await admin.get(`/admin/events/${eventId}`);
  assert.match(res.text, /People attending \(confirmed\)<\/div><div class="value">4/);

  // Scanning shows who it is and how many are registered.
  res = await admin.get(`/admin/checkin/${rsvp.qr_token}`);
  assert.match(res.text, /Valid ticket/);
  assert.match(res.text, /Raj Member/);
  assert.match(res.text, /<div class="party-count">4<\/div>/);

  // Members cannot use the check-in endpoint.
  assert.equal((await member.post(`/admin/checkin/${rsvp.qr_token}`, { guests: '4' })).status, 403);

  res = await admin.post(`/admin/checkin/${rsvp.qr_token}`, { guests: '3' });
  assert.equal(res.status, 302);
  const checked = rsvpFor(eventId, 'raj@test.org');
  assert.ok(checked.checked_in_at);
  assert.equal(checked.checked_in_count, 3);

  // Second scan: rejected and flagged as already used.
  res = await admin.post(`/admin/checkin/${rsvp.qr_token}`, { guests: '3' });
  res = await admin.follow(res);
  assert.match(res.text, /already been used/);
  assert.match(res.text, /Already used/);

  res = await admin.get(`/admin/events/${eventId}`);
  assert.match(res.text, /Checked in<\/div><div class="value">3/);

  // Member can no longer change a checked-in RSVP.
  res = await admin.follow(await member.post(`/events/${eventId}/rsvp`, { party_size: '2' }));
  assert.equal(rsvpFor(eventId, 'raj@test.org').party_size, 4);
});

test('cannot check in more guests than registered, or an unknown code', async () => {
  const admin = await login('admin@test.org', 'adminpass1');
  const eventId = await createEvent(admin, { title: 'Picnic' });
  const member = await register('guestcap@test.org');
  await member.post(`/events/${eventId}/rsvp`, { party_size: '2' });
  const rsvp = rsvpFor(eventId, 'guestcap@test.org');
  await admin.post(`/admin/checkin/${rsvp.qr_token}`, { guests: '5' });
  assert.equal(rsvpFor(eventId, 'guestcap@test.org').checked_in_at, null);
  assert.equal((await admin.get('/admin/checkin/doesnotexist123')).status, 404);
});

test('paid event: RSVP requires payment before a QR is issued', async () => {
  const admin = await login('admin@test.org', 'adminpass1');
  const eventId = await createEvent(admin, { title: 'Navratri', fee: '15' });
  const member = await register('meena@test.org', 'Meena');

  let res = await member.post(`/events/${eventId}/rsvp`, { party_size: '3' });
  assert.match(res.location, /^\/pay\/\d+\/demo$/);
  let rsvp = rsvpFor(eventId, 'meena@test.org');
  assert.equal(rsvp.status, 'pending_payment');

  // QR is not valid for check-in until paid.
  res = await admin.get(`/admin/checkin/${rsvp.qr_token}`);
  assert.match(res.text, /Payment due: \$45\.00/);
  await admin.post(`/admin/checkin/${rsvp.qr_token}`, { guests: '3' });
  assert.equal(rsvpFor(eventId, 'meena@test.org').checked_in_at, null);

  res = await member.get(res.location || `/pay/${db.prepare('SELECT MAX(id) AS id FROM payments').get().id}/demo`);
  const paymentId = db.prepare(`SELECT id FROM payments WHERE reference_id = ? AND status = 'pending'`).get(rsvp.id).id;
  res = await member.post(`/pay/${paymentId}/demo`);
  assert.equal(res.location, `/tickets/${rsvp.id}`);
  rsvp = rsvpFor(eventId, 'meena@test.org');
  assert.equal(rsvp.status, 'confirmed');

  const pay = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  assert.equal(pay.status, 'paid');
  assert.equal(pay.amount_cents, 4500);

  // Increasing the party size asks for the difference only.
  res = await member.post(`/events/${eventId}/rsvp`, { party_size: '4' });
  const topUp = db.prepare(`SELECT * FROM payments WHERE reference_id = ? AND status = 'pending'`).get(rsvp.id);
  assert.equal(topUp.amount_cents, 1500);
  assert.equal(rsvpFor(eventId, 'meena@test.org').status, 'pending_payment');

  // Admin collects the balance in cash at the door, then checks them in.
  await admin.get(`/admin/checkin/${rsvp.qr_token}`);
  res = await admin.post(`/admin/rsvps/${rsvp.id}/record-payment`, { method: 'cash', return_to: `/admin/checkin/${rsvp.qr_token}` });
  assert.equal(res.location, `/admin/checkin/${rsvp.qr_token}`);
  assert.equal(rsvpFor(eventId, 'meena@test.org').status, 'confirmed');
  await admin.post(`/admin/checkin/${rsvp.qr_token}`, { guests: '4' });
  assert.equal(rsvpFor(eventId, 'meena@test.org').checked_in_count, 4);

  res = await admin.get(`/admin/events/${eventId}`);
  assert.match(res.text, /Fees collected<\/div><div class="value">\$60\.00/);
});

test('capacity and max party size are enforced', async () => {
  const admin = await login('admin@test.org', 'adminpass1');
  const eventId = await createEvent(admin, { title: 'Small Event', capacity: '5', max_party_size: '4' });
  const a = await register('cap-a@test.org');
  const b = await register('cap-b@test.org');
  await a.post(`/events/${eventId}/rsvp`, { party_size: '4' });
  let res = await b.follow(await b.post(`/events/${eventId}/rsvp`, { party_size: '2' }));
  assert.match(res.text, /only 1 spot left/);
  assert.equal(rsvpFor(eventId, 'cap-b@test.org'), undefined);
  res = await b.follow(await b.post(`/events/${eventId}/rsvp`, { party_size: '5' }));
  assert.match(res.text, /between 1 and 4/);
});

test('cancelled RSVP frees capacity and invalidates the old QR code', async () => {
  const admin = await login('admin@test.org', 'adminpass1');
  const eventId = await createEvent(admin, { title: 'Bhajan Sandhya' });
  const m = await register('cancel@test.org');
  await m.post(`/events/${eventId}/rsvp`, { party_size: '2' });
  const oldToken = rsvpFor(eventId, 'cancel@test.org').qr_token;
  await m.post(`/events/${eventId}/cancel`);
  assert.equal(rsvpFor(eventId, 'cancel@test.org').status, 'cancelled');
  let res = await admin.get(`/admin/checkin/${oldToken}`);
  assert.match(res.text, /RSVP cancelled/);

  await m.post(`/events/${eventId}/rsvp`, { party_size: '1' });
  const fresh = rsvpFor(eventId, 'cancel@test.org');
  assert.equal(fresh.status, 'confirmed');
  assert.notEqual(fresh.qr_token, oldToken);
});

test('membership dues: plan purchase, renewal extends expiry, members-only events', async () => {
  const admin = await login('admin@test.org', 'adminpass1');
  await admin.post('/admin/plans', { name: 'Annual Family', amount: '51', duration_months: '12' });
  const planId = db.prepare(`SELECT id FROM membership_plans WHERE name = 'Annual Family'`).get().id;
  const eventId = await createEvent(admin, { title: 'AGM', members_only: '1' });

  const m = await register('dues@test.org');
  let res = await m.follow(await m.post(`/events/${eventId}/rsvp`, { party_size: '1' }));
  assert.match(res.text, /active membership/);

  res = await m.post('/membership/pay', { plan_id: String(planId) });
  const paymentId = Number(res.location.match(/\/pay\/(\d+)\/demo/)[1]);
  res = await m.post(`/pay/${paymentId}/demo`);
  assert.equal(res.location, '/membership');
  res = await m.get('/membership');
  assert.match(res.text, /badge ok">Active/);

  const first = db.prepare(`SELECT m.end_date FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'dues@test.org'`).get();
  res = await m.post('/membership/pay', { plan_id: String(planId) });
  await m.post(`/pay/${Number(res.location.match(/\/pay\/(\d+)\/demo/)[1])}/demo`);
  const ends = db.prepare(`SELECT m.end_date FROM memberships m JOIN users u ON u.id = m.user_id
                           WHERE u.email = 'dues@test.org' ORDER BY m.end_date`).all().map((r) => r.end_date);
  assert.equal(ends.length, 2);
  assert.equal(ends[0], first.end_date);
  assert.ok(ends[1] > ends[0]);

  await m.post(`/events/${eventId}/rsvp`, { party_size: '1' });
  assert.equal(rsvpFor(eventId, 'dues@test.org').status, 'confirmed');

  // Demo checkout can't be completed twice, or by another member.
  const other = await register('other@test.org');
  assert.equal((await other.post(`/pay/${paymentId}/demo`)).location, '/dashboard');
});

test('admin records an offline payment and payments ledger shows it', async () => {
  const admin = await login('admin@test.org', 'adminpass1');
  const m = await register('offline@test.org');
  const id = db.prepare(`SELECT id FROM users WHERE email = 'offline@test.org'`).get().id;
  await admin.post(`/admin/members/${id}/payments`, { kind: 'other', amount: '101', description: 'Temple donation', method: 'check', reference: '1042' });
  const res = await admin.get('/admin/payments?kind=other');
  assert.match(res.text, /Temple donation/);
  assert.match(res.text, /\$101\.00/);
  assert.match((await m.get('/payments')).text, /Temple donation/);
});

test('CSV export neutralises spreadsheet formulas', async () => {
  const { toCsv } = require('../src/util');
  assert.equal(toCsv([['=SUM(A1)', 'a,b', 'ok']]), `'=SUM(A1),"a,b",ok\r\n`);
});
