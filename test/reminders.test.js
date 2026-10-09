// Event-day reminders (a notification on the member's devices, even with the app closed) and the
// event-day pop-up inside the app.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const webpush = require('web-push');
const { startTestApp } = require('./helpers');
const reminders = require('../src/reminders');
const { nowLocal } = require('../src/util');

let t;
let admin;
const sent = [];
let failWith = null;

before(async () => {
  t = await startTestApp();
  admin = await t.adminLogin();
  // Stand in for the browsers' push services.
  webpush.sendNotification = async (sub, payload) => {
    if (failWith) { const err = new Error('gone'); err.statusCode = failWith; throw err; }
    sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
    return { statusCode: 201 };
  };
});
after(() => t.close());

const userId = (email) => t.db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const device = (n) => ({ endpoint: `https://push.example.com/send/${n}`, p256dh: 'BKey' + n, auth: 'auth' + n });

test('a device turns reminders on and off; the public key is available to the page', async () => {
  const m = await t.register('remind@test.org', 'Rina');
  const key = JSON.parse((await m.get('/reminders/key')).text).key;
  assert.match(key, /^[A-Za-z0-9_-]{80,}$/);
  assert.equal(reminders.vapidKeys(t.db).publicKey, key, 'the same key every time');
  await m.get('/profile');
  assert.match((await m.get('/profile')).text, /id="reminders"[\s\S]*Turn on reminders/);
  let res = await m.post('/reminders/subscribe', device(1));
  assert.equal(res.status, 200);
  assert.equal(t.db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint = ?').get(device(1).endpoint).user_id, userId('remind@test.org'));
  // Not a push address: refused.
  res = await m.follow(await m.post('/reminders/subscribe', { endpoint: 'javascript:alert(1)', p256dh: 'x', auth: 'y' }));
  assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint LIKE 'javascript%'`).get().n, 0);
  // A test reminder reaches the device.
  sent.length = 0;
  assert.deepEqual(JSON.parse((await m.post('/reminders/test', {})).text), { sent: 1 });
  assert.equal(sent[0].title, 'Event-day reminders are on');
  // Off (works signed out too).
  await new t.Client().post('/reminders/unsubscribe', { endpoint: device(1).endpoint });
  const anon = new t.Client(); await anon.get('/login');
  await anon.post('/reminders/unsubscribe', { endpoint: device(1).endpoint });
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?').get(device(1).endpoint).n, 0);
});

test('one reminder per person per ticket on the event day, at 9 AM, with what is due at the door', async () => {
  const day = t.futureDate(6).slice(0, 10);
  const ev = await t.createEvent(admin, { title: 'Garba Remind', fee: '5', starts_at: `${day}T19:30` });
  const m = await t.register('family-r@test.org', 'Mala');
  await m.post(`/events/${ev}/rsvp`, { party_size: '1', pay: 'door' });
  const rsvp = t.rsvpFor(ev, 'family-r@test.org');
  await m.post('/reminders/subscribe', device(2));
  await m.post('/reminders/subscribe', device(3)); // a second device (e.g. a tablet)

  assert.equal(reminders.dueReminders(t.db, `${day}T08:59`).length, 0, 'not before 9 AM');
  assert.equal(reminders.dueReminders(t.db, `${t.futureDate(5).slice(0, 10)}T12:00`).length, 0, 'not the day before');
  sent.length = 0;
  assert.equal(await reminders.sendDue(t.db, `${day}T09:00`), 2, 'both devices');
  assert.deepEqual(sent.map((s) => [s.title, s.url]), [['Today: Garba Remind', `/tickets/${rsvp.id}`], ['Today: Garba Remind', `/tickets/${rsvp.id}`]]);
  assert.match(sent[0].body, /^7:30 PM(?: · [^.]+)?\. Please pay \$5\.00 at the door\.$/); // time · place (when set)
  assert.equal(await reminders.sendDue(t.db, `${day}T12:00`), 0, 'only once');
  assert.equal(reminders.dueReminders(t.db, `${day}T19:31`).length, 0, 'not after it starts');

  // In Gujarati for a member who reads Gujarati; a family login named on the ticket is reminded too.
  const g = await t.register('gujarati-r@test.org', 'Gita');
  await g.get('/prefs?lang=gu&back=/');
  await g.post(`/events/${ev}/rsvp`, { party_size: '1', pay: 'online' });
  const gr = t.rsvpFor(ev, 'gujarati-r@test.org');
  t.db.prepare(`UPDATE rsvps SET status = 'confirmed' WHERE id = ?`).run(gr.id);
  await g.post('/reminders/subscribe', device(4));
  const kin = await t.register('kin-r@test.org', 'Kavi');
  await kin.post('/reminders/subscribe', device(5));
  const hid = Number(t.db.prepare(`INSERT INTO household_members (user_id, name, relationship, birth_year, birth_month, login_user_id) VALUES (?, 'Kavi Member', 'Spouse', 1980, 1, ?)`)
    .run(userId('gujarati-r@test.org'), userId('kin-r@test.org')).lastInsertRowid);
  t.db.prepare(`INSERT INTO rsvp_attendees (rsvp_id, event_id, person, name, relationship) VALUES (?, ?, ?, 'Kavi Member', 'Spouse')`).run(gr.id, ev, `h:${hid}`);
  assert.deepEqual(reminders.ticketPeople(t.db, gr).sort(), [userId('gujarati-r@test.org'), userId('kin-r@test.org')].sort());
  sent.length = 0;
  await reminders.sendDue(t.db, `${day}T13:00`);
  assert.deepEqual(sent.map((s) => s.endpoint).sort(), [device(4).endpoint, device(5).endpoint]);
  assert.match(sent.find((s) => s.endpoint === device(4).endpoint).title, /^આજે: Garba Remind$/);

  // Checked in already: no reminder.
  const late = await t.register('checked-r@test.org', 'Chet');
  await late.post(`/events/${ev}/rsvp`, { party_size: '1', pay: 'door' });
  await late.post('/reminders/subscribe', device(6));
  t.db.prepare(`UPDATE rsvps SET checked_in_at = datetime('now') WHERE id = ?`).run(t.rsvpFor(ev, 'checked-r@test.org').id);
  assert.equal(reminders.dueReminders(t.db, `${day}T14:00`).filter((d) => d.userId === userId('checked-r@test.org')).length, 0);
});

test('an early event is reminded two hours before; a device that was switched off is forgotten', async () => {
  assert.equal(reminders.remindAt('2026-10-20T10:00'), '08:00');
  assert.equal(reminders.remindAt('2026-10-20T19:30'), '09:00');
  const day = t.futureDate(8).slice(0, 10);
  const ev = await t.createEvent(admin, { title: 'Morning Puja', starts_at: `${day}T08:30` });
  const m = await t.register('early-r@test.org', 'Esha');
  await m.post(`/events/${ev}/rsvp`, { party_size: '1' });
  await m.post('/reminders/subscribe', device(7));
  assert.equal(reminders.dueReminders(t.db, `${day}T06:29`).length, 0);
  failWith = 410;
  await reminders.sendDue(t.db, `${day}T06:30`);
  failWith = null;
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?').get(device(7).endpoint).n, 0);
});

test('the app pops up a reminder on the day, except on the ticket itself and for people without a ticket', async (ctx) => {
  if (nowLocal().slice(11, 16) >= '23:50') return ctx.skip('too close to midnight');
  const day = nowLocal().slice(0, 10);
  const ev = await t.createEvent(admin, { title: 'Garba Today Popup', fee: '5', starts_at: `${day}T23:59` });
  const m = await t.register('popup@test.org', 'Pooja');
  await m.post(`/events/${ev}/rsvp`, { party_size: '1', pay: 'door' });
  const rsvp = t.rsvpFor(ev, 'popup@test.org');
  let res = await m.get('/dashboard');
  assert.match(res.text, new RegExp(`<dialog class="today-popup" id="today-popup" data-key="gsa-today-${rsvp.id}-${day}"[\\s\\S]*Today: Garba Today Popup[\\s\\S]*11:59 PM[\\s\\S]*Please pay \\$5\\.00 at the door\\.[\\s\\S]*href="/tickets/${rsvp.id}"[\\s\\S]*Later`));
  assert.match((await m.get('/events')).text, /id="today-popup"/, 'on other member pages too');
  assert.doesNotMatch((await m.get(`/tickets/${rsvp.id}`)).text, /id="today-popup"/, 'not over the ticket itself');
  const other = await t.register('nopopup@test.org', 'Nita');
  assert.doesNotMatch((await other.get('/dashboard')).text, /id="today-popup"/);
  // Once checked in, it stops.
  t.db.prepare(`UPDATE rsvps SET checked_in_at = datetime('now') WHERE id = ?`).run(rsvp.id);
  res = await m.get('/dashboard');
  assert.doesNotMatch(res.text, /id="today-popup"/);
});
