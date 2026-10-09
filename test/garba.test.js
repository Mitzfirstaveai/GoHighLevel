// Garba-style prices: members $5, children 10 and under free (from a locked birth month and year),
// in-state non-members $50, out-of-state guests $15, students with a school ID $15.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');
const { childAgeOn, grantMembership } = require('../src/services');

let t;
let admin;
let garba;
const year = new Date().getFullYear();
const eventDay = (() => { const d = new Date(Date.now() + 20 * 86400000); return d.toISOString().slice(0, 10); })();

before(async () => {
  t = await startTestApp();
  admin = await t.adminLogin();
  await admin.post('/admin/events', {
    title: 'Garba Night', starts_at: `${eventDay}T19:30`, fee: '5', max_party_size: '8', status: 'published', child_free_age: '10',
    allow_guests: '1', guest_fee: '50', out_of_state_fee: '15', student_fee: '15', max_guests: '6',
  });
  garba = t.db.prepare(`SELECT * FROM events WHERE title = 'Garba Night'`).get();
});
after(() => t.close());

const birth = (age, monthsFromEvent = 1) => {
  // Born `age` years before the event, in a month after the event's month (so they're exactly `age`).
  const m = ((Number(eventDay.slice(5, 7)) - 1 + monthsFromEvent) % 12) + 1;
  const y = Number(eventDay.slice(0, 4)) - age - (m > Number(eventDay.slice(5, 7)) ? 1 : 0);
  return { birth_month: String(m), birth_year: String(y) };
};

test('ages count from the birth month and year; the whole birthday month counts as the younger age', () => {
  assert.equal(childAgeOn(2015, 3, '2026-02-20'), 10);
  assert.equal(childAgeOn(2015, 3, '2026-03-31'), 10, 'still 10 in the birthday month');
  assert.equal(childAgeOn(2015, 3, '2026-04-01'), 11);
  assert.equal(childAgeOn(null, 3, '2026-04-01'), null);
  assert.equal(garba.child_free_age, 10);
  assert.deepEqual([garba.out_of_state_fee_cents, garba.student_fee_cents, garba.guest_fee_cents], [1500, 1500, 5000]);
});

test("children need a birth month and year; once saved, only the committee can change or remove them", async () => {
  const m = await t.register('kids@test.org', 'Kiran');
  let res = await m.follow(await m.post('/profile/household', { name: 'Anya', relationship: 'Daughter' }));
  assert.match(res.text, /Please enter the birth month and year for Anya/);
  res = await m.follow(await m.post('/profile/household', { name: 'Anya', relationship: 'Daughter', ...birth(9) }));
  assert.match(res.text, /Born [A-Z][a-z]+ \d{4}<\/[^>]+>|Born [A-Z][a-z]+ \d{4} 🔒/);
  assert.match(res.text, /To change or remove, ask a committee member/);
  const anya = t.db.prepare(`SELECT * FROM household_members WHERE name = 'Anya'`).get();
  res = await m.follow(await m.post(`/profile/household/${anya.id}/birth`, { birth_month: '1', birth_year: '2020' }));
  assert.match(res.text, /already saved/);
  res = await m.follow(await m.post(`/profile/household/${anya.id}/delete`));
  assert.match(res.text, /please ask a committee member/);
  assert.ok(t.db.prepare('SELECT 1 FROM household_members WHERE id = ?').get(anya.id));

  // A child added before this rule (no month) can be filled in once.
  const uid = t.db.prepare(`SELECT id FROM users WHERE email = 'kids@test.org'`).get().id;
  const old = Number(t.db.prepare(`INSERT INTO household_members (user_id, name, relationship, birth_year) VALUES (?, 'Old Kid', 'Son', 2015)`).run(uid).lastInsertRowid);
  res = await m.get('/profile');
  assert.match(res.text, new RegExp(`action="/profile/household/${old}/birth"`));
  await m.post(`/profile/household/${old}/birth`, { birth_month: '5', birth_year: '2015' });
  assert.equal(t.db.prepare('SELECT birth_month FROM household_members WHERE id = ?').get(old).birth_month, 5);

  // The committee can correct and remove.
  await admin.post(`/admin/members/${uid}/household/${anya.id}/birth`, { birth_month: '2', birth_year: '2016' });
  assert.deepEqual(Object.values(t.db.prepare('SELECT birth_month, birth_year FROM household_members WHERE id = ?').get(anya.id)), [2, 2016]);
  await admin.post(`/admin/members/${uid}/household/${old}/delete`);
  assert.equal(t.db.prepare('SELECT 1 FROM household_members WHERE id = ?').get(old), undefined);
});

test('paid members: $5 each, children 10 and under free (shown on the form and at the door)', async () => {
  const m = await t.register('fam@test.org', 'Mona');
  await m.post('/profile/household', { name: 'Kid Nine', relationship: 'Son', ...birth(9) });
  await m.post('/profile/household', { name: 'Kid Twelve', relationship: 'Daughter', ...birth(12) });
  await m.post('/profile/household', { name: 'Kid Ten', relationship: 'Son', ...birth(11, 0) }); // turns 11 in the event month: still 10
  const uid = t.db.prepare(`SELECT id FROM users WHERE email = 'fam@test.org'`).get().id;
  grantMembership(t.db, { userId: uid, planId: t.planId('Family') });

  let res = await m.get(`/events/${garba.id}`);
  assert.match(res.text, /Members \$5\.00\/person · children 10 and under free · in-state non-members \$50\.00 · out-of-state guests \$15\.00 · students with school ID \$15\.00/);
  assert.match(res.text, /Kid Nine[\s\S]*?Free \(age 9\)/);
  assert.match(res.text, /Kid Ten[\s\S]*?Free \(age 10\)/);
  assert.match(res.text, /Kid Twelve[\s\S]*?\$5\.00 member price/);

  const people = t.db.prepare(`SELECT h.id FROM household_members h WHERE h.user_id = ?`).all(uid).map((h) => `h:${h.id}`);
  res = await m.post(`/events/${garba.id}/rsvp`, { choose: '1', people: [`u:${uid}`, ...people], pay: 'door' });
  const r = t.rsvpFor(garba.id, 'fam@test.org');
  assert.equal(r.total_cents, 1000, 'Mona $5 + Kid Twelve $5; the two youngest free');
  res = await admin.get(`/admin/checkin/${r.qr_token}`);
  assert.match(res.text, /Kid Nine <span class="small muted">· age 9<\/span> <span class="badge ok">free \(child\)/);
  assert.match(res.text, /Kid Twelve <span class="small muted">· age 12<\/span><\/li>/);
});

test('non-members: $50 themselves and for older children, young children free; or $15 as a student', async () => {
  const m = await t.register('nonmem@test.org', 'Nina');
  await m.post('/profile/household', { name: 'Little One', relationship: 'Daughter', ...birth(6) });
  await m.post('/profile/household', { name: 'Big One', relationship: 'Son', ...birth(14) });
  const uid = t.db.prepare(`SELECT id FROM users WHERE email = 'nonmem@test.org'`).get().id;
  const ids = t.db.prepare('SELECT id FROM household_members WHERE user_id = ? ORDER BY id').all(uid).map((h) => `h:${h.id}`);
  let res = await m.get(`/events/${garba.id}`);
  assert.match(res.text, /Big One[\s\S]*?\$50\.00 non-member price/);
  assert.match(res.text, /You are coming as[\s\S]*value="student"/);
  await m.post(`/events/${garba.id}/rsvp`, { choose: '1', people: [`u:${uid}`, ...ids], pay: 'door' });
  assert.equal(t.rsvpFor(garba.id, 'nonmem@test.org').total_cents, 10000, 'Nina $50 + Big One $50; Little One free');

  // A student coming on their own pays the student price, and the door is told to check the ID.
  const s = await t.register('student@test.org', 'Sam');
  const sid = t.db.prepare(`SELECT id FROM users WHERE email = 'student@test.org'`).get().id;
  await s.post(`/events/${garba.id}/rsvp`, { choose: '1', people: `u:${sid}`, self_type: 'student', pay: 'door' });
  const sr = t.rsvpFor(garba.id, 'student@test.org');
  assert.equal(sr.total_cents, 1500);
  assert.match((await admin.get(`/admin/checkin/${sr.qr_token}`)).text, /Sam Member[\s\S]*?Student — check school ID/);
});

test('guests by kind: in-state $50, out-of-state $15, students $15, children free — with ID reminders at the door', async () => {
  const m = await t.register('host@test.org', 'Hema');
  const uid = t.db.prepare(`SELECT id FROM users WHERE email = 'host@test.org'`).get().id;
  grantMembership(t.db, { userId: uid, planId: t.planId('Family') });
  await m.post(`/events/${garba.id}/rsvp`, {
    choose: '1', people: `u:${uid}`, guests_instate: '1', guests_outofstate: '2', guests_student: '1', guests_child: '1', pay: 'door',
  });
  const r = t.rsvpFor(garba.id, 'host@test.org');
  assert.equal(r.total_cents, 500 + 5000 + 3000 + 1500);
  assert.equal(r.party_size, 6);
  assert.deepEqual(JSON.parse(r.guest_types), { instate: 1, outofstate: 2, student: 1, child: 1 });
  const door = (await admin.get(`/admin/checkin/${r.qr_token}`)).text;
  assert.match(door, /2 out-of-state guests <span class="badge warn">🪪 check ID/);
  assert.match(door, /1 student <span class="badge warn">🎓 check school ID/);
  assert.match(door, /1 child guest <span class="badge ok">free — age 10 and under/);
  assert.match((await admin.get(`/admin/events/${garba.id}/attendees.csv`)).text, /1 in-state, 2 out-of-state, 1 student, 1 child/);

  // Kinds the event doesn't offer are refused.
  const plain = await t.createEvent(admin, { title: 'Plain Dinner', fee: '10', allow_guests: '1', guest_fee: '20' });
  const res = await m.follow(await m.post(`/events/${plain}/rsvp`, { choose: '1', people: `u:${uid}`, guests_student: '1' }));
  assert.match(res.text, /does not offer that kind of guest/);
});

test('money already paid shows on the form and at checkout, also after cancelling (it counts toward a new RSVP)', async () => {
  const m = await t.register('credit@test.org', 'Cora', 0);
  await m.post('/profile/household', { name: 'Cora Spouse', relationship: 'Spouse' });
  const uid = t.db.prepare(`SELECT id FROM users WHERE email = 'credit@test.org'`).get().id;
  grantMembership(t.db, { userId: uid, planId: t.planId('Family') });
  const spouse = `h:${t.db.prepare('SELECT id FROM household_members WHERE user_id = ?').get(uid).id}`;

  // Cora pays $5 online for herself, then cancels.
  let res = await m.post(`/events/${garba.id}/rsvp`, { choose: '1', people: `u:${uid}`, pay: 'online' });
  await m.post(`${res.location}`, { method: 'demo' });
  const r = t.rsvpFor(garba.id, 'credit@test.org');
  await m.post(`/events/${garba.id}/cancel`, {});
  res = await m.get(`/events/${garba.id}`);
  assert.match(res.text, /You cancelled your RSVP\. The \$5\.00 you already paid is non-refundable, but it counts toward a new RSVP/);
  assert.match(res.text, /data-paid="500"/);

  // Coming back with her spouse: $10 total, $5 already paid, so checkout asks for $5 and says why.
  res = await m.post(`/events/${garba.id}/rsvp`, { choose: '1', people: [`u:${uid}`, spouse], pay: 'online' });
  res = await m.get(res.location);
  assert.match(res.text, /\$5\.00<\/p>\s*<p class="muted">Total \$10\.00 − already paid \$5\.00<\/p>/);
  assert.equal(t.rsvpFor(garba.id, 'credit@test.org').id, r.id);

  // An RSVP with nothing paid yet shows no breakdown.
  assert.match((await t.register('nocredit@test.org', 'Nia', 0).then((n) => n.get(`/events/${garba.id}`))).text, /data-paid="0"/);
});
