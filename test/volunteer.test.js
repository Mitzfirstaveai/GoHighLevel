// Door volunteers: members an admin allows to use the check-in scanner, and nothing else.
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

before(async () => {
  t = await startTestApp();
  admin = await t.login('admin@test.org', 'adminpass1');
  await t.register('door@test.org', 'Dhruv');
  const res = await admin.follow(await admin.post(`/admin/members/${userId('door@test.org')}/checkin-access`, { access: '1' }));
  assert.match(res.text, /Door check-in turned on/);
  assert.match(res.text, /Door volunteer/);
  volunteer = await t.login('door@test.org', 'secret123');
  todayEvent = await t.createEvent(admin, { title: 'Garba Tonight', starts_at: `${nowLocal().slice(0, 10)}T23:59` });
});
after(() => t.close());

test('a door volunteer can open the scanner but no other admin page', async () => {
  let res = await volunteer.get('/dashboard');
  assert.match(res.text, /href="\/admin\/checkin"/);
  res = await volunteer.get('/admin/checkin');
  assert.equal(res.status, 200);
  assert.match(res.text, /Door check-in/);
  assert.match(res.text, /Today · Garba Tonight/);
  assert.doesNotMatch(res.text, /class="subnav"/); // no admin menu
  assert.doesNotMatch(res.text, /Door volunteers/); // the volunteer list is for admins
  for (const path of ['/admin', '/admin/members', `/admin/members/${userId('door@test.org')}`, '/admin/payments',
    '/admin/events', `/admin/events/${todayEvent}`, '/admin/reports', '/admin/donations', '/admin/members.csv']) {
    assert.equal((await volunteer.get(path)).status, 403, path);
  }
  // Admins see who has door access.
  res = await admin.get('/admin/checkin');
  assert.match(res.text, /Door volunteers/);
  assert.match(res.text, /Dhruv Member/);
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
  assert.match(res.text, /by Dhruv Member — 3 of 4 people/);
  assert.equal(t.rsvpFor(todayEvent, 'family1@test.org').checked_in_by, userId('door@test.org'));
  // The same code can't be used twice.
  res = await volunteer.follow(await volunteer.post(`/admin/checkin/${token}`, { guests: '1' }));
  assert.match(res.text, /already been used/);
  // The running count updates.
  res = await volunteer.get(`/admin/checkin?event=${todayEvent}`);
  assert.match(res.text, /1 of 1 tickets scanned/);
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

test('a volunteer cannot record payments; they send the family to the committee', async () => {
  const paid = await t.createEvent(admin, { title: 'Dinner Tonight', fee: '15', starts_at: `${nowLocal().slice(0, 10)}T23:59` });
  const m = await t.register('family4@test.org', 'Dev');
  await m.post(`/events/${paid}/rsvp`, { party_size: '1' });
  const rsvp = t.rsvpFor(paid, 'family4@test.org');
  let res = await volunteer.get(`/admin/checkin/${rsvp.qr_token}`);
  assert.match(res.text, /Payment due: \$15\.00/);
  assert.match(res.text, /send them to a committee member to pay/);
  assert.doesNotMatch(res.text, /Record payment/);
  res = await volunteer.post(`/admin/rsvps/${rsvp.id}/record-payment`, { method: 'cash' });
  assert.equal(res.status, 403);
  assert.equal(t.rsvpFor(paid, 'family4@test.org').status, 'pending_payment');
  // An admin still gets the payment form on the same screen.
  res = await admin.get(`/admin/checkin/${rsvp.qr_token}`);
  assert.match(res.text, /Record payment/);
});

test('ordinary members cannot check people in; opening their own QR link shows their ticket', async () => {
  const m = await t.register('family5@test.org', 'Esha');
  await m.post(`/events/${todayEvent}/rsvp`, { party_size: '1' });
  const own = t.rsvpFor(todayEvent, 'family5@test.org');
  assert.equal((await m.get('/admin/checkin')).status, 403);
  assert.doesNotMatch((await m.get('/dashboard')).text, /href="\/admin\/checkin"/);
  let res = await m.get(`/admin/checkin/${own.qr_token}`);
  assert.equal(res.location, `/tickets/${own.id}`);
  res = await m.get(`/admin/checkin/${t.rsvpFor(todayEvent, 'family1@test.org').qr_token}`);
  assert.equal(res.status, 403);
  res = await m.post(`/admin/checkin/${own.qr_token}`, { guests: '1' });
  assert.equal(res.status, 403);
  assert.equal(t.rsvpFor(todayEvent, 'family5@test.org').checked_in_at, null);
  // Signed out, the link asks them to sign in.
  res = await new t.Client().get(`/admin/checkin/${own.qr_token}`);
  assert.equal(res.location, '/login');
});

test('door access needs an email, and can be turned off again', async () => {
  await admin.post('/admin/members/new', { first_name: 'No', last_name: 'Email' });
  const id = t.db.prepare(`SELECT id FROM users WHERE first_name = 'No' AND last_name = 'Email'`).get().id;
  let res = await admin.follow(await admin.post(`/admin/members/${id}/checkin-access`, { access: '1' }));
  assert.match(res.text, /Add an email address first/);
  assert.equal(t.db.prepare('SELECT checkin_access FROM users WHERE id = ?').get(id).checkin_access, 0);

  await t.register('temp@test.org', 'Temp');
  const tempId = userId('temp@test.org');
  await admin.post(`/admin/members/${tempId}/checkin-access`, { access: '1' });
  const temp = await t.login('temp@test.org', 'secret123');
  assert.equal((await temp.get('/admin/checkin')).status, 200);
  res = await admin.post(`/admin/members/${tempId}/checkin-access`, { access: '0', return_to: '/admin/checkin' });
  assert.equal(res.location, '/admin/checkin');
  assert.equal((await temp.get('/admin/checkin')).status, 403);
  // A volunteer can't give anyone else access.
  res = await volunteer.post(`/admin/members/${tempId}/checkin-access`, { access: '1' });
  assert.equal(res.status, 403);
});

test('the check-in screens are fully translated for Gujarati-reading volunteers', async () => {
  const m = await t.register('family6@test.org', 'Falgun', 1);
  await m.post(`/events/${todayEvent}/rsvp`, { party_size: '2' });
  const token = t.rsvpFor(todayEvent, 'family6@test.org').qr_token;
  await volunteer.get('/prefs?lang=gu&back=/');
  missing.clear();
  let res = await volunteer.get('/dashboard');
  assert.match(res.text, /દરવાજે પ્રવેશ/);
  res = await volunteer.get(`/admin/checkin?event=${todayEvent}&q=Falgun`);
  assert.match(res.text, /નામથી પરિવાર શોધો/);
  res = await volunteer.get(`/admin/checkin?event=${todayEvent}&q=zzzz`);
  res = await volunteer.get(`/admin/checkin/${token}`);
  assert.match(res.text, /માન્ય ટિકિટ/);
  res = await volunteer.follow(await volunteer.post(`/admin/checkin/${token}`, { guests: '2' }));
  assert.match(res.text, /Falgun Memberનો પ્રવેશ થયો — 2 વ્યક્તિ/);
  await volunteer.get('/admin/checkin/not-a-real-code-123');
  await volunteer.get('/admin');
  assert.deepEqual([...missing], [], `Untranslated text: ${[...missing].join(' | ')}`);
  await volunteer.get('/prefs?lang=en&back=/');
});
