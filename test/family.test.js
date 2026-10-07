// Choosing who's coming by name, changing it from My tickets, and family logins.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');

let t;
let admin;

before(async () => {
  t = await startTestApp();
  admin = await t.login('admin@test.org', 'adminpass1');
});
after(() => t.close());

const userId = (email) => t.db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const personKey = (email, name) => (name
  ? `h:${t.db.prepare('SELECT id FROM household_members WHERE user_id = ? AND name = ?').get(userId(email), name).id}`
  : `u:${userId(email)}`);
const names = (rsvpId) => t.db.prepare('SELECT name FROM rsvp_attendees WHERE rsvp_id = ? ORDER BY id').all(rsvpId).map((a) => a.name);

// A Family-level member with a spouse and two children on their profile.
async function family(email, first) {
  const m = await t.register(email, first, 2); // Child 1, Child 2 + Family membership
  await m.post('/profile/household', { name: `${first}'s Spouse`, relationship: 'Spouse' });
  return m;
}

test('members choose who is coming by name; the ticket shows those names', async () => {
  const m = await family('priya@test.org', 'Priya');
  const eventId = await t.createEvent(admin, { title: 'Navratri Night' });
  let res = await m.get(`/events/${eventId}`);
  assert.match(res.text, /Who&#39;s coming\?/);
  for (const n of ['Priya Member', 'Child 1', 'Child 2', 'Priya&#39;s Spouse']) assert.match(res.text, new RegExp(n));

  // Me and the two kids, not my spouse.
  res = await m.post(`/events/${eventId}/rsvp`, {
    choose: '1', people: [personKey('priya@test.org'), personKey('priya@test.org', 'Child 1'), personKey('priya@test.org', 'Child 2')],
  });
  const rsvp = t.rsvpFor(eventId, 'priya@test.org');
  assert.equal(res.location, `/tickets/${rsvp.id}`);
  assert.equal(rsvp.party_size, 3);
  assert.deepEqual(names(rsvp.id), ['Priya Member', 'Child 1', 'Child 2']);

  res = await m.get(`/tickets/${rsvp.id}`);
  assert.match(res.text, /This ticket is for/);
  assert.match(res.text, /<li>Child 2<\/li>/);
  assert.doesNotMatch(res.text, /<li>Priya&#39;s Spouse<\/li>/);
  res = await m.get('/tickets');
  assert.match(res.text, /Priya Member, Child 1, Child 2/);
  assert.match(res.text, new RegExp(`href="/tickets/${rsvp.id}#change">Change who&#39;s coming`));

  // The door sees the names too.
  res = await admin.get(`/admin/checkin/${rsvp.qr_token}`);
  assert.match(res.text, /Names on this ticket/);
  assert.match(res.text, /<li>Child 1<\/li>/);
  res = await admin.get(`/admin/events/${eventId}`);
  assert.match(res.text, /Priya Member, Child 1, Child 2/);
  res = await admin.get(`/admin/events/${eventId}/attendees.csv`);
  assert.match(res.text, /"Priya Member, Child 1, Child 2"/);
});

test('only family on the profile, covered by the level, can be registered', async () => {
  const eventId = await t.createEvent(admin, { title: 'Members Picnic' });
  const m = await t.login('priya@test.org', 'secret123');
  const other = await family('other@test.org', 'Other');
  // Someone from another family, or a made-up person.
  let res = await m.follow(await m.post(`/events/${eventId}/rsvp`, { choose: '1', people: [personKey('priya@test.org'), personKey('other@test.org', 'Child 1')] }));
  assert.match(res.text, /Please choose people from your family list/);
  res = await m.follow(await m.post(`/events/${eventId}/rsvp`, { choose: '1', people: 'h:99999' }));
  assert.match(res.text, /Please choose people from your family list/);
  // A parent the Family level doesn't cover (added by an admin as an exception).
  await admin.post(`/admin/members/${userId('priya@test.org')}/household`, { name: 'Papa', relationship: 'Father' });
  res = await m.get(`/events/${eventId}`);
  assert.match(res.text, /Not covered by your membership level/);
  res = await m.follow(await m.post(`/events/${eventId}/rsvp`, { choose: '1', people: [personKey('priya@test.org'), personKey('priya@test.org', 'Papa')] }));
  assert.match(res.text, /Papa isn&#39;t covered by your membership level/);
  // Ticking nobody.
  res = await m.follow(await m.post(`/events/${eventId}/rsvp`, { choose: '1' }));
  assert.match(res.text, /Please choose who is coming/);
  assert.equal(t.rsvpFor(eventId, 'priya@test.org'), undefined);
  await other.get('/');
});

test('changing who is coming from My tickets issues a new QR code and keeps the answers', async () => {
  const eventId = await t.createEvent(admin, { title: 'Bhajan Evening', questions: '*Dietary preference: Regular, Jain' });
  const m = await t.login('priya@test.org', 'secret123');
  await m.post(`/events/${eventId}/rsvp`, { choose: '1', people: [personKey('priya@test.org')], q_0: 'Jain' });
  const before = t.rsvpFor(eventId, 'priya@test.org');
  let res = await m.get(`/tickets/${before.id}`);
  assert.match(res.text, /id="change"/);
  assert.match(res.text, /name="from" value="ticket"/);

  // Spouse changes their mind: add them from the ticket page (no question answers sent).
  res = await m.post(`/events/${eventId}/rsvp`, {
    from: 'ticket', choose: '1', people: [personKey('priya@test.org'), personKey('priya@test.org', "Priya's Spouse")],
  });
  assert.equal(res.location, `/tickets/${before.id}`);
  const after = t.rsvpFor(eventId, 'priya@test.org');
  assert.equal(after.party_size, 2);
  assert.notEqual(after.qr_token, before.qr_token);
  assert.deepEqual(names(after.id), ['Priya Member', "Priya's Spouse"]);
  assert.match(after.answers, /Jain/);
  res = await admin.get(`/admin/checkin/${before.qr_token}`);
  assert.match(res.text, /Old QR code — replaced/);

  // Swapping one person for another (same head count) also replaces the code.
  await m.post(`/events/${eventId}/rsvp`, {
    from: 'ticket', choose: '1', people: [personKey('priya@test.org'), personKey('priya@test.org', 'Child 1')],
  });
  const swapped = t.rsvpFor(eventId, 'priya@test.org');
  assert.equal(swapped.party_size, 2);
  assert.notEqual(swapped.qr_token, after.qr_token);
  assert.deepEqual(names(swapped.id), ['Priya Member', 'Child 1']);
});

test('a family member gets their own login and can only add people not already registered', async () => {
  const m = await t.login('priya@test.org', 'secret123');
  const spouseRow = personKey('priya@test.org', "Priya's Spouse").slice(2);
  let res = await m.follow(await m.post(`/profile/household/${spouseRow}/email`, { email: 'spouse@test.org' }));
  assert.match(res.text, /can now join the app with spouse@test\.org/);
  assert.match(res.text, /Can join with spouse@test\.org/);

  // The spouse joins with that email and is linked to the family.
  const s = new t.Client();
  await s.get('/register');
  res = await s.post('/register', { email: 'spouse@test.org', password: 'secret123', password_confirm: 'secret123', first_name: 'Sam', last_name: 'Member' });
  assert.equal(res.location, '/dashboard');
  res = await s.get('/dashboard');
  assert.match(res.text, /You&#39;re part of Priya Member&#39;s family membership/);
  assert.equal(t.db.prepare('SELECT owner_id FROM users WHERE email = ?').get('spouse@test.org').owner_id, userId('priya@test.org'));
  assert.match((await m.get('/profile')).text, /Has own login/);

  // Priya registered herself and the kids; the spouse can only add themselves.
  const eventId = await t.createEvent(admin, { title: 'Garba Night 2', starts_at: t.futureDate(3) }); // within the door's 7-day list
  await m.post(`/events/${eventId}/rsvp`, {
    choose: '1', people: [personKey('priya@test.org'), personKey('priya@test.org', 'Child 1'), personKey('priya@test.org', 'Child 2')],
  });
  res = await s.get(`/events/${eventId}`);
  assert.match(res.text, /Already registered on Priya Member&#39;s ticket/);
  const box = (key) => res.text.match(new RegExp(`<input type="checkbox" name="people" value="${key}"[^>]*>`))[0];
  assert.match(box(personKey('priya@test.org', 'Child 1')), /disabled/);
  assert.doesNotMatch(box(`h:${spouseRow}`), /disabled/);
  assert.match(box(`h:${spouseRow}`), /checked/);
  res = await s.follow(await s.post(`/events/${eventId}/rsvp`, { choose: '1', people: [`h:${spouseRow}`, personKey('priya@test.org', 'Child 1')] }));
  assert.match(res.text, /Child 1 is already registered for this event on Priya Member&#39;s ticket/);
  res = await s.post(`/events/${eventId}/rsvp`, { choose: '1', people: [`h:${spouseRow}`] });
  const spouseTicket = t.db.prepare('SELECT * FROM rsvps WHERE event_id = ? AND user_id = ?').get(eventId, userId('spouse@test.org'));
  assert.equal(res.location, `/tickets/${spouseTicket.id}`);
  assert.deepEqual(names(spouseTicket.id), ["Priya's Spouse"]);
  // Covered by the family membership: member price, members-only events allowed.
  assert.match((await s.get('/membership')).text, /You&#39;re covered by Priya Member&#39;s family membership/);

  // Both see the family's tickets; each changes only their own.
  res = await m.get('/tickets');
  assert.match(res.text, /Sam Member&#39;s ticket/);
  assert.doesNotMatch(res.text, new RegExp(`/tickets/${spouseTicket.id}#change`));
  res = await m.get(`/tickets/${spouseTicket.id}`);
  assert.equal(res.status, 200);
  assert.doesNotMatch(res.text, /id="change"/);
  // ...and Priya can't put the spouse on her ticket now.
  res = await m.follow(await m.post(`/events/${eventId}/rsvp`, { choose: '1', people: [personKey('priya@test.org'), `h:${spouseRow}`] }));
  assert.match(res.text, /already registered for this event on Sam Member&#39;s ticket/);
  // The door can find the spouse's ticket by the name on it.
  res = await admin.get(`/admin/checkin?event=${eventId}&q=${encodeURIComponent("Priya's Spouse")}`);
  assert.match(res.text, new RegExp(`/admin/checkin/${spouseTicket.qr_token}`));
  // ...and a child's name finds only the ticket the child is on.
  res = await admin.get(`/admin/checkin?event=${eventId}&q=Child%201`);
  assert.match(res.text, new RegExp(`/admin/checkin/${t.rsvpFor(eventId, 'priya@test.org').qr_token}`));
  assert.doesNotMatch(res.text, new RegExp(`/admin/checkin/${spouseTicket.qr_token}`));

  // Family logins don't manage the family list or pay the dues.
  res = await s.follow(await s.post('/profile/household', { name: 'Someone', relationship: 'Son' }));
  assert.match(res.text, /Your family list is managed by the member who added you/);
  res = await s.follow(await s.post('/membership/pay', { plan_id: String(t.planId('Family')) }));
  assert.match(res.text, /part of your family membership/);
  assert.match((await s.get('/profile')).text, /Priya manages this list/);
});

test('family emails must be new, and removing the person ends the link', async () => {
  const m = await t.login('priya@test.org', 'secret123');
  const child = personKey('priya@test.org', 'Child 2').slice(2);
  let res = await m.follow(await m.post(`/profile/household/${child}/email`, { email: 'other@test.org' }));
  assert.match(res.text, /That email already has an account/);
  res = await m.follow(await m.post(`/profile/household/${child}/email`, { email: 'spouse@test.org' }));
  assert.match(res.text, /That email already has an account/);
  res = await m.follow(await m.post(`/profile/household/${child}/email`, { email: 'not-an-email' }));
  assert.match(res.text, /valid email address/);

  const spouseRow = personKey('priya@test.org', "Priya's Spouse").slice(2);
  await m.post(`/profile/household/${spouseRow}/delete`, {});
  assert.equal(t.db.prepare('SELECT owner_id FROM users WHERE email = ?').get('spouse@test.org').owner_id, null);
});

test('members-only events do not take guests', async () => {
  const eventId = await t.createEvent(admin, { title: 'AGM', members_only: '1', allow_guests: '1', guest_fee: '0' });
  const m = await t.login('priya@test.org', 'secret123');
  const res = await m.get(`/events/${eventId}`);
  assert.doesNotMatch(res.text, /name="guests"/);
  const post = await m.follow(await m.post(`/events/${eventId}/rsvp`, { choose: '1', people: [personKey('priya@test.org')], guests: '2' }));
  assert.match(post.text, /This event does not allow guests/);
});
