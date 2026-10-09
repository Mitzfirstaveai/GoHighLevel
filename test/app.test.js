const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');

let t;
let db;
let Client;
let login;
let register;
let planId;
let futureDate;
let createEvent;
let rsvpFor;

before(async () => {
  t = await startTestApp();
  ({ db, Client, login, adminLogin, register, planId, futureDate, createEvent, rsvpFor } = t);
});

after(() => t.close());


// How many family members can be ticked on an event's "Who's coming?" list.
const choosable = (html) => (html.match(/<input type="checkbox" name="people"[^>]*>/g) || []).filter((tag) => !/disabled/.test(tag)).length;

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
  await member.post('/profile/household', { name: 'Diya Shah', relationship: 'Daughter', birth_month: '3', birth_year: '2014' });

  const admin = await adminLogin();
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
  const admin = await adminLogin();
  const eventId = await createEvent(admin, { title: 'Diwali Sneh Milan' });

  const member = await register('raj@test.org', 'Raj', 3);
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
  const admin = await adminLogin();
  const eventId = await createEvent(admin, { title: 'Picnic' });
  const member = await register('guestcap@test.org', 'Test', 1);
  await member.post(`/events/${eventId}/rsvp`, { party_size: '2' });
  const rsvp = rsvpFor(eventId, 'guestcap@test.org');
  await admin.post(`/admin/checkin/${rsvp.qr_token}`, { guests: '5' });
  assert.equal(rsvpFor(eventId, 'guestcap@test.org').checked_in_at, null);
  assert.equal((await admin.get('/admin/checkin/doesnotexist123')).status, 404);
});

test('paid event: RSVP requires payment before a QR is issued', async () => {
  const admin = await adminLogin();
  const eventId = await createEvent(admin, { title: 'Navratri', fee: '15' });
  const member = await register('meena@test.org', 'Meena', 3);

  let res = await member.post(`/events/${eventId}/rsvp`, { party_size: '3' });
  assert.match(res.location, /^\/pay\/\d+\/demo$/);
  let rsvp = rsvpFor(eventId, 'meena@test.org');
  assert.equal(rsvp.status, 'pending_payment');

  // QR is not valid for check-in until paid.
  res = await admin.get(`/admin/checkin/${rsvp.qr_token}`);
  assert.match(res.text, /Not paid yet[\s\S]*\$45\.00 DUE/);
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
  rsvp = rsvpFor(eventId, 'meena@test.org'); // a new QR code was issued for the new guest count

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
  const admin = await adminLogin();
  const eventId = await createEvent(admin, { title: 'Small Event', capacity: '5', max_party_size: '4' });
  const a = await register('cap-a@test.org', 'Test', 3);
  const b = await register('cap-b@test.org', 'Test', 5);
  await a.post(`/events/${eventId}/rsvp`, { party_size: '4' });
  let res = await b.follow(await b.post(`/events/${eventId}/rsvp`, { party_size: '2' }));
  assert.match(res.text, /only 1 spot left/);
  assert.equal(rsvpFor(eventId, 'cap-b@test.org'), undefined);
  res = await b.follow(await b.post(`/events/${eventId}/rsvp`, { party_size: '5' }));
  assert.match(res.text, /between 1 and 4/);
});

test('cancelled RSVP frees capacity and invalidates the old QR code', async () => {
  const admin = await adminLogin();
  const eventId = await createEvent(admin, { title: 'Bhajan Sandhya' });
  const m = await register('cancel@test.org', 'Test', 1);
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

test('membership levels: join, members-only events, renewal extends to next year', async () => {
  const admin = await adminLogin();
  const eventId = await createEvent(admin, { title: 'AGM', members_only: '1' });

  const m = await register('dues@test.org');
  let res = await m.follow(await m.post(`/events/${eventId}/rsvp`, { party_size: '1' }));
  assert.match(res.text, /active membership/);

  await m.post('/profile', { first_name: 'Test', last_name: 'Member', date_of_birth: '1985-03-12' }); // Individual is 18+
  res = await m.get('/membership');
  assert.match(res.text, new RegExp(`Joining now covers you through <strong>Dec 31, ${new Date().getFullYear()}`));
  res = await m.post('/membership/pay', { plan_id: String(planId('Individual')) });
  const paymentId = Number(res.location.match(/\/pay\/(\d+)\/demo/)[1]);
  assert.equal(db.prepare('SELECT amount_cents FROM payments WHERE id = ?').get(paymentId).amount_cents, 16500);
  res = await m.post(`/pay/${paymentId}/demo`);
  assert.equal(res.location, '/membership');
  res = await m.get('/membership');
  assert.match(res.text, /badge ok">Active/);
  const year = new Date().getFullYear();
  const rows = () => db.prepare(`SELECT m.* FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.email = 'dues@test.org' ORDER BY m.id`).all();
  assert.equal(rows()[0].end_date, `${year}-12-31`);

  // Renewing the same level pays full price and covers next calendar year.
  res = await m.post('/membership/pay', { plan_id: String(planId('Individual')) });
  await m.post(`/pay/${Number(res.location.match(/\/pay\/(\d+)\/demo/)[1])}/demo`);
  assert.equal(rows()[1].start_date, `${year + 1}-01-01`);
  assert.equal(rows()[1].end_date, `${year + 1}-12-31`);

  await m.post(`/events/${eventId}/rsvp`, { party_size: '1' });
  assert.equal(rsvpFor(eventId, 'dues@test.org').status, 'confirmed');

  // Demo checkout can't be completed twice, or by another member.
  const other = await register('other@test.org');
  assert.equal((await other.post(`/pay/${paymentId}/demo`)).location, '/dashboard');
});

test('age-restricted level needs a qualifying date of birth', async () => {
  const m = await register('senior@test.org');
  let res = await m.follow(await m.post('/membership/pay', { plan_id: String(planId('Senior Citizen')) }));
  assert.match(res.text, /Add your date of birth/);
  await m.post('/profile', { first_name: 'Test', last_name: 'Member', date_of_birth: '1990-05-01' });
  res = await m.follow(await m.post('/membership/pay', { plan_id: String(planId('Senior Citizen')) }));
  assert.match(res.text, /aged 65 or older/);
  await m.post('/profile', { first_name: 'Test', last_name: 'Member', date_of_birth: '1950-05-01' });
  res = await m.post('/membership/pay', { plan_id: String(planId('Senior Citizen')) });
  assert.match(res.location, /\/pay\/\d+\/demo/);
});

test('membership level limits who can be on the profile; upgrade pays the difference', async () => {
  const admin = await adminLogin();
  const m = await register('couple@test.org');
  await m.post('/profile/household', { name: 'Nisha', relationship: 'Spouse' });
  await m.post('/profile', { first_name: 'Test', last_name: 'Member', date_of_birth: '1985-03-12' });

  // A level that doesn't fit the listed family can't be chosen.
  let res = await m.follow(await m.post('/membership/pay', { plan_id: String(planId('Individual')) }));
  assert.match(res.text, /does not include a spouse/);

  res = await m.post('/membership/pay', { plan_id: String(planId('Married Couple')) });
  await m.post(`/pay/${Number(res.location.match(/\/pay\/(\d+)\/demo/)[1])}/demo`);

  // Married Couple excludes children and parents.
  res = await m.follow(await m.post('/profile/household', { name: 'Dev', relationship: 'Son', birth_month: '5', birth_year: '2012' }));
  assert.match(res.text, /Married Couple membership covers you and your spouse, so Dev can&#39;t be added\. Upgrade to Family/);
  res = await m.follow(await m.post('/profile/household', { name: 'Second Wife', relationship: 'Spouse' }));
  assert.match(res.text, /can&#39;t be added/);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM household_members h JOIN users u ON u.id = h.user_id WHERE u.email = 'couple@test.org'`).get().n, 1);

  // Event guest limit = member + covered family.
  const eventId = await createEvent(admin, { title: 'Couple Event' });
  res = await m.get(`/events/${eventId}`);
  assert.equal(choosable(res.text), 2); // people who can be ticked on the RSVP form

  // Upgrade to Family: pays only the $55 difference, keeps the same end date.
  res = await m.get('/membership');
  assert.match(res.text, /Upgrade — pay \$55\.00 difference/);
  res = await m.post('/membership/pay', { plan_id: String(planId('Family')) });
  const upgradeId = Number(res.location.match(/\/pay\/(\d+)\/demo/)[1]);
  const upgrade = db.prepare('SELECT * FROM payments WHERE id = ?').get(upgradeId);
  assert.equal(upgrade.amount_cents, 5500);
  assert.equal(upgrade.kind, 'membership_upgrade');
  await m.post(`/pay/${upgradeId}/demo`);
  res = await m.get('/membership');
  assert.match(res.text, /<strong>Family<\/strong> — valid through/);

  await m.post('/profile/household', { name: 'Dev', relationship: 'Son', birth_month: '5', birth_year: '2012' });
  await m.post('/profile/household', { name: 'Riya', relationship: 'Daughter', birth_month: '9', birth_year: '2009' });
  res = await m.follow(await m.post('/profile/household', { name: 'Papa', relationship: 'Father' }));
  assert.match(res.text, /Upgrade to Family with Parents/);
  res = await m.get(`/events/${eventId}`);
  assert.equal(choosable(res.text), 4); // people who can be ticked on the RSVP form

  // Admins can add beyond the level as an exception, with a warning.
  const id = db.prepare(`SELECT id FROM users WHERE email = 'couple@test.org'`).get().id;
  res = await admin.follow(await admin.post(`/admin/members/${id}/household`, { name: 'Papa', relationship: 'Father' }));
  assert.match(res.text, /more than the member&#39;s current level covers/);
  assert.match(res.text, /More family listed than this level covers/);
  // ...but the uncovered parent still doesn't count toward event guests.
  res = await m.get(`/events/${eventId}`);
  assert.equal(choosable(res.text), 4); // people who can be ticked on the RSVP form
});

test('without an active membership a member can only RSVP for themselves', async () => {
  const admin = await adminLogin();
  const eventId = await createEvent(admin, { title: 'Open Event' });
  const m = await register('nomember@test.org');
  await m.post('/profile/household', { name: 'Nisha', relationship: 'Spouse' });
  const res = await m.get(`/events/${eventId}`);
  assert.equal(choosable(res.text), 1); // people who can be ticked on the RSVP form
  assert.match(res.text, /Pay your membership<\/a> to bring your family/);
});

test('admin records an offline payment and payments ledger shows it', async () => {
  const admin = await adminLogin();
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

test('guest limit is the member plus family members on their profile', async () => {
  const admin = await adminLogin();
  const eventId = await createEvent(admin, { title: 'Family Limit', max_party_size: '10' });
  const m = await register('family@test.org', 'Test', 2); // member + 2 children = 3
  let res = await m.get(`/events/${eventId}`);
  assert.equal(choosable(res.text), 3); // people who can be ticked on the RSVP form
  res = await m.follow(await m.post(`/events/${eventId}/rsvp`, { party_size: '4' }));
  assert.match(res.text, /between 1 and 3/);
  assert.equal(rsvpFor(eventId, 'family@test.org'), undefined);
  await m.post(`/events/${eventId}/rsvp`, { party_size: '3' });
  assert.equal(rsvpFor(eventId, 'family@test.org').party_size, 3);

  const single = await register('single@test.org');
  res = await single.follow(await single.post(`/events/${eventId}/rsvp`, { party_size: '2' }));
  assert.match(res.text, /covered by your membership level can come with you/);
});

test('changing 4 → 2 guests on a free event: old QR stops working, new QR issued everywhere', async () => {
  const admin = await adminLogin();
  const eventId = await createEvent(admin, { title: 'Free Garba' });
  const m = await register('change@test.org', 'Asha', 3);

  await m.post(`/events/${eventId}/rsvp`, { party_size: '4' });
  const before = rsvpFor(eventId, 'change@test.org');
  assert.equal(before.status, 'confirmed');

  // Re-submitting the same number keeps the same QR.
  await m.post(`/events/${eventId}/rsvp`, { party_size: '4' });
  assert.equal(rsvpFor(eventId, 'change@test.org').qr_token, before.qr_token);

  let res = await m.post(`/events/${eventId}/rsvp`, { party_size: '2' });
  assert.equal(res.location, `/tickets/${before.id}`);
  res = await m.get(res.location);
  assert.match(res.text, /A new QR code was issued — your old QR code no longer works/);
  assert.doesNotMatch(res.text, /refund/i);
  assert.match(res.text, /data:image\/png;base64/);
  assert.match(res.text, /<p class="party-count"[^>]*>2<\/p>/);

  const after = rsvpFor(eventId, 'change@test.org');
  assert.equal(after.status, 'confirmed');
  assert.equal(after.party_size, 2);
  assert.notEqual(after.qr_token, before.qr_token);

  // Old QR: shown as replaced and cannot be checked in.
  res = await admin.get(`/admin/checkin/${before.qr_token}`);
  assert.equal(res.status, 404);
  assert.match(res.text, /Old QR code — replaced/);
  assert.match(res.text, /now 2 people/);
  res = await admin.follow(await admin.post(`/admin/checkin/${before.qr_token}`, { guests: '2' }));
  assert.match(res.text, /replaced by a newer one/);
  assert.equal(rsvpFor(eventId, 'change@test.org').checked_in_at, null);

  // Admin's guest list uses the new QR and the new headcount.
  res = await admin.get(`/admin/events/${eventId}`);
  assert.ok(res.text.includes(`/admin/checkin/${after.qr_token}`));
  assert.ok(!res.text.includes(before.qr_token));
  assert.match(res.text, /People attending \(confirmed\)<\/div><div class="value">2/);

  // New QR checks in 2 people.
  res = await admin.get(`/admin/checkin/${after.qr_token}`);
  assert.match(res.text, /<div class="party-count">2<\/div>/);
  await admin.post(`/admin/checkin/${after.qr_token}`, { guests: '2' });
  assert.equal(rsvpFor(eventId, 'change@test.org').checked_in_count, 2);
});

test('paid event: reducing guests gives no refund; paid amount stays as credit', async () => {
  const admin = await adminLogin();
  const eventId = await createEvent(admin, { title: 'Paid Dinner', fee: '15' });
  const m = await register('norefund@test.org', 'Test', 3);

  let res = await m.post(`/events/${eventId}/rsvp`, { party_size: '4' });
  await m.post(`/pay/${Number(res.location.match(/\/pay\/(\d+)\/demo/)[1])}/demo`);
  res = await m.get(`/events/${eventId}`);
  assert.match(res.text, /non-refundable/);

  res = await m.follow(await m.post(`/events/${eventId}/rsvp`, { party_size: '2' }));
  assert.doesNotMatch(res.text, /coming back to you|refund pending/i);
  const rsvp = rsvpFor(eventId, 'norefund@test.org');
  assert.equal(rsvp.status, 'confirmed');
  assert.equal(rsvp.party_size, 2);

  res = await admin.get(`/admin/events/${eventId}`);
  assert.doesNotMatch(res.text, /Refund/);
  assert.match(res.text, /Fees collected<\/div><div class="value">\$60\.00/);

  // Going back up to 4 is already covered by what they paid — no new charge.
  res = await m.post(`/events/${eventId}/rsvp`, { party_size: '4' });
  assert.match(res.location, /^\/tickets\//);
  assert.equal(rsvpFor(eventId, 'norefund@test.org').status, 'confirmed');
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE reference_id = ? AND status = 'pending'`).get(rsvp.id).n, 0);
});

test('About, Committee, Sponsors and Contact pages are public', async () => {
  const anon = new Client();
  let res = await anon.get('/about');
  assert.equal(res.status, 200);
  assert.match(res.text, /founded in 1989 by 35 Gujarati families/);
  assert.match(res.text, /Together, We Serve Better/);
  res = await anon.get('/committee');
  assert.match(res.text, /Board of Trustees/);
  assert.match(res.text, /Executive Committee/);
  res = await anon.get('/contact');
  assert.match(res.text, /1 GSA Circle/);
  assert.match(res.text, /\(501\) 916-2416/);
  assert.equal((await anon.get('/sponsors')).status, 200);
  // Member-only pages still need sign-in.
  assert.equal((await anon.get('/directory')).location, '/login');
  assert.equal((await anon.get('/news')).location, '/login');
});

test('member directory respects privacy settings', async () => {
  const shown = await register('listed@test.org', 'Listed');
  await shown.post('/profile', { first_name: 'Listed', last_name: 'Person', phone: '501-555-7777', city: 'Cabot' });
  await shown.post('/profile/privacy', { directory_listed: '1', directory_contact: '1' });
  const hidden = await register('hidden@test.org', 'Hidden');
  await hidden.post('/profile', { first_name: 'Hidden', last_name: 'Person' });
  await hidden.post('/profile/privacy', {});
  const quiet = await register('quiet@test.org', 'Quiet');
  await quiet.post('/profile', { first_name: 'Quiet', last_name: 'Person', phone: '501-555-8888' });

  const res = await quiet.get('/directory?q=Person');
  assert.match(res.text, /Listed Person/);
  assert.match(res.text, /501-555-7777/);
  assert.match(res.text, /Quiet Person/);
  assert.doesNotMatch(res.text, /501-555-8888/); // contact details are opt-in
  assert.doesNotMatch(res.text, /Hidden Person/);
});

test('admin posts news that members see', async () => {
  const admin = await adminLogin();
  const member = await register('reader@test.org');
  assert.equal((await member.post('/admin/news', { title: 'x', body: 'y' })).status, 403);
  await admin.post('/admin/news', { title: 'Garba volunteers needed', body: 'Please sign up at the front desk.' });
  let res = await member.get('/news');
  assert.match(res.text, /Garba volunteers needed/);
  res = await member.get('/dashboard');
  assert.match(res.text, /GSA announcements/);
  assert.match(res.text, /Garba volunteers needed/);
});
