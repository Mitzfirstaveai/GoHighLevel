// Choosing who's coming by name, changing it from My tickets, and family logins.
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
  let res = await m.follow(await m.post(`/profile/household/${spouseRow}/invite`, {}));
  assert.match(res.text, /Invite link for Priya&#39;s Spouse is ready/);
  const token = t.db.prepare('SELECT invite_token FROM household_members WHERE id = ?').get(spouseRow).invite_token;
  const link = `http://test.local/join/family/${token}`;
  assert.match(res.text, new RegExp(`value="${link}"`));
  assert.match(res.text, new RegExp(`href="https://wa.me/\\?text=${encodeURIComponent(`Join our family on the GSA app: ${link}`).replace(/[()*!']/g, (c) => `\\${c}`)}"`));
  assert.match(res.text, /Send by text message/);

  // The spouse opens the private link and creates their own login.
  const s = new t.Client();
  res = await s.get(`/join/family/${token}`);
  assert.match(res.text, /Priya Member invited Priya&#39;s Spouse to have their own login/);
  res = await s.post(`/join/family/${token}`, { email: 'spouse@test.org', password: 'secret123', password_confirm: 'secret123', first_name: 'Sam', last_name: 'Member' });
  assert.equal(res.location, '/dashboard');
  res = await s.get('/dashboard');
  assert.match(res.text, /You&#39;re part of Priya Member&#39;s family membership/);
  assert.equal(t.db.prepare('SELECT owner_id FROM users WHERE email = ?').get('spouse@test.org').owner_id, userId('priya@test.org'));
  assert.match((await m.get('/profile')).text, /Has own login/);
  // The link worked once and is now spent.
  assert.equal((await new t.Client().get(`/join/family/${token}`)).status, 404);

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
  res = await s.follow(await s.post('/profile/household', { name: 'Someone', relationship: 'Son', birth_month: '1', birth_year: '2015' }));
  assert.match(res.text, /Your family list is managed by the member who added you/);
  res = await s.follow(await s.post('/membership/pay', { plan_id: String(t.planId('Family')) }));
  assert.match(res.text, /part of your family membership/);
  assert.match((await s.get('/profile')).text, /Priya manages this list/);
});

test('only the invite link joins a family: not a matching email, a used, expired or cancelled link', async () => {
  const m = await t.login('priya@test.org', 'secret123');
  const child = Number(personKey('priya@test.org', 'Child 2').slice(2));
  // The old loophole: setting up a login with an email the member listed no longer links anyone.
  t.db.prepare(`UPDATE household_members SET email = 'child2@test.org' WHERE id = ?`).run(child);
  const stranger = new t.Client();
  await stranger.get('/register');
  await stranger.post('/register', { email: 'child2@test.org', password: 'secret123', password_confirm: 'secret123', first_name: 'Not', last_name: 'Family' });
  assert.equal(t.db.prepare('SELECT owner_id FROM users WHERE email = ?').get('child2@test.org').owner_id, null);
  assert.equal(t.db.prepare('SELECT login_user_id FROM household_members WHERE id = ?').get(child).login_user_id, null);

  // Made-up, expired and cancelled links don't work.
  assert.equal((await stranger.get('/join/family/not-a-real-invite-token-123')).status, 404);
  await m.post(`/profile/household/${child}/invite`, {});
  const token = () => t.db.prepare('SELECT invite_token FROM household_members WHERE id = ?').get(child).invite_token;
  const first = token();
  t.db.prepare(`UPDATE household_members SET invite_expires = datetime('now', '-1 minute') WHERE id = ?`).run(child);
  let res = await new t.Client().get(`/join/family/${first}`);
  assert.equal(res.status, 404);
  assert.match(res.text, /no longer valid/);
  await m.post(`/profile/household/${child}/invite`, {}); // a fresh link replaces the old one
  assert.notEqual(token(), first);
  const second = token();
  await m.post(`/profile/household/${child}/invite/cancel`, {});
  assert.equal((await new t.Client().get(`/join/family/${second}`)).status, 404);

  // Only the member who holds the family can make links for it.
  const outsider = await t.login('other@test.org', 'secret123');
  res = await outsider.follow(await outsider.post(`/profile/household/${child}/invite`, {}));
  assert.match(res.text, /Family member not found/);
  const spouse = await t.login('spouse@test.org', 'secret123');
  res = await spouse.follow(await spouse.post(`/profile/household/${child}/invite`, {}));
  assert.match(res.text, /managed by the member who added you/);
  assert.equal(token(), null);
});

test('someone who already has a login can join with the link, unless that account has its own family or membership', async () => {
  const m = await t.login('priya@test.org', 'secret123');
  const child = Number(personKey('priya@test.org', 'Child 2').slice(2));
  await m.post(`/profile/household/${child}/invite`, {});
  const token = t.db.prepare('SELECT invite_token FROM household_members WHERE id = ?').get(child).invite_token;

  // The member's own link, opened by themselves: they can sign out and carry on as the invited person.
  let own = await m.get(`/join/family/${token}`);
  assert.match(own.text, /This is your own invite link/);
  assert.match(own.text, /Sign out and create Child 2&#39;s login/);
  own = await m.post(`/join/family/${token}/switch`, {});
  assert.equal(own.location, `/join/family/${token}`);
  own = await m.get(own.location);
  assert.match(own.text, /Create my login/);
  assert.equal((await m.get('/dashboard')).location, '/login'); // Priya is signed out
  // An account with its own Family membership can't be merged in.
  const other = await t.login('other@test.org', 'secret123');
  let res = await other.get(`/join/family/${token}`);
  assert.match(res.text, /has its own membership, family list or event tickets/);
  assert.doesNotMatch(res.text, /Join the family<\/button>/);
  res = await other.follow(await other.post(`/join/family/${token}/link`, {}));
  assert.match(res.text, /has its own membership/);
  assert.equal(t.db.prepare('SELECT owner_id FROM users WHERE email = ?').get('other@test.org').owner_id, null);

  // A plain account (signed out first: the link brings them back after signing in).
  const c = new t.Client();
  await c.get(`/join/family/${token}`);
  await c.get('/login');
  res = await c.post('/login', { email: 'child2@test.org', password: 'secret123' });
  assert.equal(res.location, `/join/family/${token}`);
  res = await c.get(res.location);
  assert.match(res.text, /Join the family<\/button>/);
  res = await c.follow(await c.post(`/join/family/${token}/link`, {}));
  assert.match(res.text, /You&#39;re part of Priya Member&#39;s family membership/);
  assert.equal(t.db.prepare('SELECT owner_id FROM users WHERE email = ?').get('child2@test.org').owner_id, userId('priya@test.org'));
  assert.equal(t.db.prepare('SELECT login_user_id FROM household_members WHERE id = ?').get(child).login_user_id, userId('child2@test.org'));
});

test('removing a family member ends their family login link', async () => {
  const m = await t.login('priya@test.org', 'secret123');
  const spouseRow = personKey('priya@test.org', "Priya's Spouse").slice(2);
  await m.post(`/profile/household/${spouseRow}/delete`, {});
  assert.equal(t.db.prepare('SELECT owner_id FROM users WHERE email = ?').get('spouse@test.org').owner_id, null);
});
