// Door volunteers: members an admin allows to use the check-in scanner, and nothing else.
// They sign in at the committee & volunteer sign-in (/admin/login), which opens door mode.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');
const { missing } = require('../src/i18n');
const { nowLocal } = require('../src/util');

let t;
let admin;
let volunteer;
let todayEvent;

const userId = (email) => t.db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

async function doorLogin(email, password = 'secret123') {
  const c = new t.Client();
  await c.get('/admin/login');
  const res = await c.post('/admin/login', { email, password });
  assert.equal(res.status, 302);
  assert.equal(res.location, '/admin/checkin');
  await c.get('/admin/checkin'); // CSRF token for the new session
  return c;
}

before(async () => {
  t = await startTestApp();
  admin = await t.adminLogin();
  await t.register('door@test.org', 'Dhruv');
  const res = await admin.follow(await admin.post(`/admin/members/${userId('door@test.org')}/checkin-access`, { access: '1' }));
  assert.match(res.text, /Door check-in turned on/);
  assert.match(res.text, /Door volunteer/);
  volunteer = await doorLogin('door@test.org');
  todayEvent = await t.createEvent(admin, { title: 'Garba Tonight', starts_at: `${nowLocal().slice(0, 10)}T23:59` });
});
after(() => t.close());

test('a door volunteer sees only check-in: no member menus and no other admin page', async () => {
  let res = await volunteer.get('/admin/checkin');
  assert.equal(res.status, 200);
  assert.match(res.text, /Door check-in/);
  assert.match(res.text, /id="quick-mode"/); // the quick-mode switch sits under the camera
  assert.match(res.text, /Today · Garba Tonight/);
  assert.match(res.text, /class="[^"]*door-mode/);
  assert.match(res.text, />Sign out</);
  assert.doesNotMatch(res.text, /href="\/tickets"/); // no member menu
  assert.doesNotMatch(res.text, /class="tabbar/);
  assert.doesNotMatch(res.text, /class="subnav[ "]/); // no admin menu
  assert.doesNotMatch(res.text, /Door volunteers/); // the volunteer list is for admins
  // Everything else sends them back to check-in.
  for (const path of ['/', '/dashboard', '/tickets', '/profile', '/admin', '/admin/members', `/admin/members/${userId('door@test.org')}`,
    '/admin/payments', `/admin/events/${todayEvent}`, '/admin/reports', '/admin/donations', '/admin/members.csv']) {
    res = await volunteer.get(path);
    assert.equal(res.location, '/admin/checkin', path);
  }
  // Admins see who has door access.
  res = await admin.get('/admin/checkin');
  assert.match(res.text, /Door volunteers/);
  assert.match(res.text, /Dhruv Member/);
});

test('signed in to the member app, a volunteer is an ordinary member', async () => {
  const c = await t.login('door@test.org', 'secret123');
  for (const path of ['/dashboard', '/events', '/more']) assert.doesNotMatch((await c.get(path)).text, /admin\/checkin|Check-in/, path);
  assert.equal((await c.get('/admin/members')).status, 403);
  // Opening the scanner (or a ticket link) asks them to use the committee & volunteer sign-in, then returns there.
  const token = (await (async () => {
    const m = await t.register('family0@test.org', 'Zara');
    await m.post(`/events/${todayEvent}/rsvp`, { party_size: '1' });
    return t.rsvpFor(todayEvent, 'family0@test.org').qr_token;
  })());
  let res = await c.get(`/admin/checkin/${token}`);
  assert.equal(res.location, '/admin/login');
  res = await c.get('/admin/login');
  assert.match(res.text, /signed in to the member app as Dhruv Member/);
  res = await c.post('/admin/login', { email: 'door@test.org', password: 'secret123' });
  assert.equal(res.location, `/admin/checkin/${token}`);
  assert.match((await c.get(res.location)).text, /Valid ticket/);
  // Signing out of door mode leaves the volunteer sign-in ready for the next person.
  res = await c.post('/logout', {});
  assert.equal(res.location, '/admin/login');
});

test('the committee & volunteer sign-in turns ordinary members away and takes admins to the admin area', async () => {
  await t.register('plain@test.org', 'Plain');
  const c = new t.Client();
  let res = await c.get('/login');
  assert.match(res.text, /class="staff-signin">\s*<a class="btn big secondary" href="\/admin\/login">[\s\S]*?Committee &amp; volunteer sign-in<\/a>/);
  // It sits right under the member Sign in button, above everything else.
  assert.ok(res.text.indexOf('class="staff-signin"') < res.text.indexOf('New here?'));
  await c.get('/admin/login');
  res = await c.post('/admin/login', { email: 'plain@test.org', password: 'secret123' });
  assert.equal(res.status, 403);
  assert.match(res.text, /only for the committee and door volunteers/);
  assert.equal((await c.get('/dashboard')).location, '/login'); // not signed in
  assert.equal((await c.get('/admin/checkin')).location, '/admin/login'); // and no door check-in
  // A family login (spouse) isn't let in either, unless an admin assigns them as a door volunteer.
  t.db.prepare(`UPDATE users SET owner_id = (SELECT id FROM users WHERE email = 'door@test.org') WHERE email = 'plain@test.org'`).run();
  res = await c.post('/admin/login', { email: 'plain@test.org', password: 'secret123' });
  assert.equal(res.status, 403);
  t.db.prepare(`UPDATE users SET owner_id = NULL WHERE email = 'plain@test.org'`).run();
  res = await c.post('/admin/login', { email: 'door@test.org', password: 'wrong-password' });
  assert.equal(res.status, 401);
  const a = new t.Client();
  await a.get('/admin/login');
  res = await a.post('/admin/login', { email: 'admin@test.org', password: 'adminpass1' });
  assert.equal(res.location, '/admin');
  res = await a.get('/admin');
  assert.match(res.text, /class="subnav[ "]/);
  assert.doesNotMatch(res.text, /door-mode/);
});

test('a door volunteer checks a family in, and is recorded as the person who did', async () => {
  const m = await t.register('family1@test.org', 'Asha', 3);
  await m.post(`/events/${todayEvent}/rsvp`, { party_size: '4' });
  const token = t.rsvpFor(todayEvent, 'family1@test.org').qr_token;
  let res = await volunteer.get(`/admin/checkin/${token}`);
  assert.match(res.text, /Valid ticket/);
  assert.doesNotMatch(res.text, /not today/);
  res = await volunteer.follow(await volunteer.post(`/admin/checkin/${token}`, { guests: '3' }));
  assert.match(res.text, /Checked in Asha Member — 3 people\./);
  // Quick mode (if switched on on this device) returns to the running camera after a check-in…
  assert.match(res.text, new RegExp(`id="auto-return" data-url="/admin/checkin\\?event=${todayEvent}#scanner"`));
  assert.match(res.text, /Stay on this page/);
  assert.match(res.text, /by Dhruv Member — 3 of 4 people/);
  assert.equal(t.rsvpFor(todayEvent, 'family1@test.org').checked_in_by, userId('door@test.org'));
  // The same code can't be used twice.
  res = await volunteer.follow(await volunteer.post(`/admin/checkin/${token}`, { guests: '1' }));
  assert.match(res.text, /already been used/);
  assert.doesNotMatch(res.text, /id="auto-return"/); // …but never when something needs attention
  // The running count updates.
  res = await volunteer.get(`/admin/checkin?event=${todayEvent}`);
  assert.match(res.text, /1 of 2 tickets scanned/); // Asha's family, plus Zara from the earlier test
});

test('volunteers can find a family by name, family member or phone when there is no phone to scan', async () => {
  const m = await t.register('family2@test.org', 'Bhavna', 1);
  t.db.prepare(`UPDATE users SET last_name = 'Trivedi', phone = '(501) 555-0177' WHERE email = 'family2@test.org'`).run();
  await m.post(`/events/${todayEvent}/rsvp`, { party_size: '2' });
  const other = await t.createEvent(admin, { title: 'Another Event' });
  const n = await t.register('family3@test.org', 'Chetan');
  t.db.prepare(`UPDATE users SET last_name = 'Trivedi' WHERE email = 'family3@test.org'`).run();
  await n.post(`/events/${other}/rsvp`, { party_size: '1' });

  const search = (q) => volunteer.get(`/admin/checkin?event=${todayEvent}&q=${encodeURIComponent(q)}`);
  const token = t.rsvpFor(todayEvent, 'family2@test.org').qr_token;
  for (const q of ['trivedi', 'Bhavna Triv', 'Child 1', '5550177', '555-0177']) {
    const res = await search(q);
    assert.match(res.text, new RegExp(`href="/admin/checkin/${token}"`), q);
    assert.doesNotMatch(res.text, /Chetan/, q); // other events' RSVPs are not listed
  }
  let res = await search('%');
  assert.doesNotMatch(res.text, /Bhavna/);
  assert.match(res.text, /No RSVP for Garba Tonight matches/);
  res = await search('nobody here');
  assert.match(res.text, /No RSVP for Garba Tonight matches/);
});

test('pay at the door: QR code straight away, the door sees what is due, collects it and sees PAID', async () => {
  const paid = await t.createEvent(admin, { title: 'Dinner Tonight', fee: '15', starts_at: `${nowLocal().slice(0, 10)}T23:59` });
  const m = await t.register('family4@test.org', 'Dev');
  let res = await m.get(`/events/${paid}`);
  assert.match(res.text, /How will you pay\?[\s\S]*value="online" checked[\s\S]*value="door"/, 'online is the default; the door is offered');
  res = await m.post(`/events/${paid}/rsvp`, { party_size: '1', pay: 'door' });
  const rsvp = t.rsvpFor(paid, 'family4@test.org');
  assert.equal(res.location, `/tickets/${rsvp.id}`);
  assert.deepEqual([rsvp.status, rsvp.pay_at_door], ['confirmed', 1]);
  res = await m.get(res.location);
  assert.match(res.text, /Please pay \$15\.00 in cash at the door/);
  assert.match(res.text, /data:image\/png;base64/, 'QR code shown before paying');
  assert.match((await m.get('/dashboard')).text, /Pay \$15\.00 at the door/);

  // At the door: big amount due, and the volunteer records the cash.
  res = await volunteer.get(`/admin/checkin/${rsvp.qr_token}`);
  assert.match(res.text, /class="pay-panel due"[\s\S]*\$15\.00 DUE[\s\S]*They chose to pay at the door/);
  assert.doesNotMatch(res.text, /Check in without payment|<button class="btn big ok">Check in<\/button>/, 'no way in without paying');
  // Even sent directly, check-in is refused while money is owed.
  res = await volunteer.follow(await volunteer.post(`/admin/checkin/${rsvp.qr_token}`, { guests: '1' }));
  assert.match(res.text, /Payment is still owed for this RSVP/);
  assert.equal(t.rsvpFor(paid, 'family4@test.org').checked_in_at, null);
  assert.match((await volunteer.get(`/admin/checkin?event=${paid}&q=Dev`)).text, /\$15\.00 due/);
  // Volunteers still can't use the admin pages; the door has its own button.
  res = await volunteer.post(`/admin/rsvps/${rsvp.id}/record-payment`, { method: 'cash' });
  assert.equal(res.location, '/admin/checkin');
  // Event fees are cash at the door: no Check button, and a check is refused even if sent directly.
  assert.doesNotMatch((await volunteer.get(`/admin/checkin/${rsvp.qr_token}`)).text, /value="check"/);
  res = await volunteer.follow(await volunteer.post(`/admin/checkin/${rsvp.qr_token}/payment`, { method: 'check', checkin: '1', guests: '1' }));
  assert.match(res.text, /Event fees are cash only at the door — checks are not accepted/);
  assert.equal(t.rsvpFor(paid, 'family4@test.org').checked_in_at, null);
  // One tap: Cash records the money and checks them in (Quick mode then returns to the camera).
  res = await volunteer.follow(await volunteer.post(`/admin/checkin/${rsvp.qr_token}/payment`, { method: 'cash', checkin: '1', guests: '1' }));
  assert.match(res.text, /Recorded \$15\.00 paid by cash and checked in Dev Member — 1 person/);
  assert.match(res.text, /✅ Checked in/);
  assert.match(res.text, /id="auto-return"/, 'Quick mode goes back to the camera');
  assert.match(res.text, /class="pay-panel paid"[\s\S]*PAID[\s\S]*\$15\.00 paid \(cash\)/);
  assert.equal(t.rsvpFor(paid, 'family4@test.org').checked_in_count, 1);
  const pay = t.db.prepare(`SELECT * FROM payments WHERE kind = 'event' AND reference_id = ? AND status = 'paid'`).get(rsvp.id);
  assert.deepEqual([pay.amount_cents, pay.method], [1500, 'cash']);

  // Someone who paid online shows PAID (online) at the door.
  const n = await t.register('paydoor-online@test.org', 'Online');
  res = await n.post(`/events/${paid}/rsvp`, { party_size: '1', pay: 'online' });
  await n.post(res.location);
  const online = t.rsvpFor(paid, 'paydoor-online@test.org');
  assert.equal(online.status, 'confirmed');
  assert.match((await volunteer.get(`/admin/checkin/${online.qr_token}`)).text, /PAID[\s\S]*\$15\.00 paid \(online\)/);

  // Started paying online but switches to the door: QR code right away.
  const o = await t.register('paydoor-switch@test.org', 'Switch');
  await o.post(`/events/${paid}/rsvp`, { party_size: '1' });
  assert.equal(t.rsvpFor(paid, 'paydoor-switch@test.org').status, 'pending_payment');
  res = await o.post(`/events/${paid}/pay-at-door`);
  assert.equal(t.rsvpFor(paid, 'paydoor-switch@test.org').status, 'confirmed');
  assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE reference_id = ? AND kind = 'event' AND status = 'pending'`).get(t.rsvpFor(paid, 'paydoor-switch@test.org').id).n, 0);
  assert.match((await admin.get(`/admin/events/${paid}`)).text, /Pays at door/);
});

test('ordinary members cannot check people in; opening their own QR link shows their ticket', async () => {
  const m = await t.register('family5@test.org', 'Esha');
  await m.post(`/events/${todayEvent}/rsvp`, { party_size: '1' });
  const own = t.rsvpFor(todayEvent, 'family5@test.org');
  assert.equal((await m.get('/admin/checkin')).status, 403);
  let res = await m.get(`/admin/checkin/${own.qr_token}`);
  assert.equal(res.location, `/tickets/${own.id}`);
  res = await m.get(`/admin/checkin/${t.rsvpFor(todayEvent, 'family1@test.org').qr_token}`);
  assert.equal(res.status, 403);
  res = await m.post(`/admin/checkin/${own.qr_token}`, { guests: '1' });
  assert.equal(res.status, 403);
  assert.equal(t.rsvpFor(todayEvent, 'family5@test.org').checked_in_at, null);
  // Signed out, the link goes to the committee & volunteer sign-in (it's volunteers who scan these).
  res = await new t.Client().get(`/admin/checkin/${own.qr_token}`);
  assert.equal(res.location, '/admin/login');
});

test('door access needs an email, and can be turned off again', async () => {
  await admin.post('/admin/members/new', { first_name: 'No', last_name: 'Email' });
  const id = t.db.prepare(`SELECT id FROM users WHERE first_name = 'No' AND last_name = 'Email'`).get().id;
  let res = await admin.follow(await admin.post(`/admin/members/${id}/checkin-access`, { access: '1' }));
  assert.match(res.text, /Add an email address first/);
  assert.equal(t.db.prepare('SELECT checkin_access FROM users WHERE id = ?').get(id).checkin_access, 0);

  await t.register('temp@test.org', 'Temp');
  const tempId = userId('temp@test.org');
  t.db.prepare(`UPDATE users SET tags = 'Donor' WHERE id = ?`).run(tempId);
  await admin.post(`/admin/members/${tempId}/checkin-access`, { access: '1' });
  // Door volunteers are tagged Volunteer automatically, keeping their other tags.
  const tags = () => t.db.prepare('SELECT tags FROM users WHERE id = ?').get(tempId).tags;
  assert.equal(tags(), 'Donor,Volunteer');
  const temp = await doorLogin('temp@test.org');
  assert.equal((await temp.get('/admin/checkin')).status, 200);
  res = await admin.post(`/admin/members/${tempId}/checkin-access`, { access: '0', return_to: '/admin/checkin' });
  assert.equal(res.location, '/admin/checkin');
  assert.equal((await temp.get('/admin/checkin')).status, 403);
  assert.equal(tags(), 'Donor,Volunteer', 'turning door access off keeps the Volunteer tag');
  await admin.post(`/admin/members/${tempId}/checkin-access`, { access: '1' });
  assert.equal(tags(), 'Donor,Volunteer', 'no duplicate tag');
  await admin.post(`/admin/members/${tempId}/checkin-access`, { access: '0' });
  // A volunteer can't give anyone else access.
  res = await volunteer.post(`/admin/members/${tempId}/checkin-access`, { access: '1' });
  assert.equal(res.location, '/admin/checkin');
  assert.equal(t.db.prepare('SELECT checkin_access FROM users WHERE id = ?').get(tempId).checkin_access, 0);
  const asMember = await t.login('door@test.org', 'secret123');
  assert.equal((await asMember.post(`/admin/members/${tempId}/checkin-access`, { access: '1' })).status, 403);
});

test('the check-in screens are fully translated for Gujarati-reading volunteers', async () => {
  const m = await t.register('family6@test.org', 'Falgun', 1);
  await m.post(`/events/${todayEvent}/rsvp`, { party_size: '2' });
  const token = t.rsvpFor(todayEvent, 'family6@test.org').qr_token;
  await volunteer.get('/prefs?lang=gu&back=/');
  missing.clear();
  let res = await volunteer.get(`/admin/checkin?event=${todayEvent}&q=Falgun`);
  assert.match(res.text, /દરવાજે પ્રવેશ/);
  assert.match(res.text, /નામથી પરિવાર શોધો/);
  res = await volunteer.get(`/admin/checkin?event=${todayEvent}&q=zzzz`);
  res = await volunteer.get(`/admin/checkin/${token}`);
  assert.match(res.text, /માન્ય ટિકિટ/);
  res = await volunteer.follow(await volunteer.post(`/admin/checkin/${token}`, { guests: '2' }));
  assert.match(res.text, /Falgun Memberનો પ્રવેશ થયો — 2 વ્યક્તિ/);
  await volunteer.get('/admin/checkin/not-a-real-code-123');
  const anon = new t.Client();
  await anon.get('/prefs?lang=gu&back=/');
  assert.match((await anon.get('/admin/login')).text, /સમિતિ અને સ્વયંસેવક સાઇન ઇન/);
  await t.register('plain-gu@test.org', 'Gita');
  res = await anon.post('/admin/login', { email: 'plain-gu@test.org', password: 'secret123' });
  assert.match(res.text, /કૃપા કરી સભ્ય સાઇન ઇનનો ઉપયોગ કરો/);
  assert.deepEqual([...missing], [], `Untranslated text: ${[...missing].join(' | ')}`);
  await volunteer.get('/prefs?lang=en&back=/');
});

test('at the door, a family can pay on their phone (screen turns green) or by Venmo / PayPal / Zelle to GSA', async () => {
  const ev = await t.createEvent(admin, { title: 'Garba At The Door', fee: '20', starts_at: `${nowLocal().slice(0, 10)}T23:59` });
  const m = await t.register('phonepay@test.org', 'Pia');
  await m.post(`/events/${ev}/rsvp`, { party_size: '1', pay: 'door' });
  const rsvp = t.rsvpFor(ev, 'phonepay@test.org');

  // The door shows Cash, Venmo, PayPal, Zelle / other — and a QR code to pay on their own phone.
  let res = await volunteer.get(`/admin/checkin/${rsvp.qr_token}`);
  assert.match(res.text, /value="cash"[\s\S]*value="venmo"[\s\S]*value="paypal"[\s\S]*value="other">Zelle \/ other/);
  assert.match(res.text, /id="pay-online" data-due-url="\/admin\/checkin\/[^"]+\/due"[\s\S]*<img src="data:image\/png;base64/);
  assert.deepEqual(JSON.parse((await volunteer.get(`/admin/checkin/${rsvp.qr_token}/due`)).text), { due: 2000 });

  // The QR opens the pay page on their phone; paying with Venmo there settles it.
  res = await m.get(`/tickets/${rsvp.id}/pay`);
  assert.match(res.text, /\$20\.00[\s\S]*Pay \$20\.00 now/);
  res = await m.post(`/tickets/${rsvp.id}/pay`, {});
  assert.match(res.location, /^\/pay\/\d+\/demo$/);
  res = await m.follow(await m.post(res.location, { method: 'venmo' }));
  assert.match(res.text, /Payment received/);
  assert.deepEqual(JSON.parse((await volunteer.get(`/admin/checkin/${rsvp.qr_token}/due`)).text), { due: 0 });
  res = await volunteer.get(`/admin/checkin/${rsvp.qr_token}`);
  assert.match(res.text, /class="pay-panel paid"[\s\S]*\$20\.00 paid \(Venmo\)/);
  assert.doesNotMatch(res.text, /id="pay-online"/);
  assert.match((await m.get(`/tickets/${rsvp.id}/pay`)).text, /Paid — show this to the volunteer/);

  // Someone else's ticket can't be paid from another family's phone.
  const other = await t.register('notmine@test.org', 'Omar');
  assert.equal((await other.get(`/tickets/${rsvp.id}/pay`)).status, 404);

  // Money sent to GSA's PayPal: the volunteer taps PayPal, which records it and checks them in.
  const m2 = await t.register('paypalsent@test.org', 'Ravi');
  await m2.post(`/events/${ev}/rsvp`, { party_size: '1', pay: 'door' });
  const r2 = t.rsvpFor(ev, 'paypalsent@test.org');
  res = await volunteer.follow(await volunteer.post(`/admin/checkin/${r2.qr_token}/payment`, { method: 'paypal', checkin: '1', guests: '1' }));
  assert.match(res.text, /Recorded \$20\.00 paid by PayPal and checked in Ravi Member — 1 person/);
  const pay = t.db.prepare(`SELECT method, recorded_by FROM payments WHERE kind = 'event' AND reference_id = ? AND status = 'paid'`).get(r2.id);
  assert.deepEqual({ ...pay }, { method: 'paypal', recorded_by: userId('door@test.org') });
});
