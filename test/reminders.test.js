// Event reminders (a notification on the member's devices, even with the app closed) and the
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
  assert.equal(sent[0].title, 'Event reminders are on');
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
  // A sign-up made with keys this server no longer has (403) is dropped too. Not delivered, so not used up:
  // when the phone signs up again (the app does this by itself), the reminder goes out.
  await m.post('/reminders/subscribe', device(7));
  failWith = 403;
  assert.equal(await reminders.sendDue(t.db, `${day}T06:35`), 0);
  failWith = null;
  assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE endpoint = ?').get(device(7).endpoint).n, 0);
  await m.post('/reminders/subscribe', device(8));
  sent.length = 0;
  assert.equal(await reminders.sendDue(t.db, `${day}T06:40`), 1);
  assert.equal(sent[0].title, 'Today: Morning Puja');
  assert.equal(await reminders.sendDue(t.db, `${day}T06:45`), 0, 'then only once');
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

test('each event sets its own reminders: a week before, the day before and the morning of, each at its time', async () => {
  const day = t.futureDate(20).slice(0, 10);
  const ev = await t.createEvent(admin, {
    title: 'Diwali Remind', starts_at: `${day}T17:00`,
    remind_day_of: '1', remind_day_of_time: '08:30', remind_day_before: '1', remind_day_before_time: '18:00',
    remind_week_before: '1', remind_week_before_time: '10:00',
  });
  const m = await t.register('schedule@test.org', 'Sona');
  await m.post(`/events/${ev}/rsvp`, { party_size: '1' });
  await m.post('/reminders/subscribe', device(20));
  const dayMinus = (n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - n); return d.toISOString().slice(0, 10); };
  const titles = async (now) => { sent.length = 0; await reminders.sendDue(t.db, now); return sent.filter((s) => s.endpoint === device(20).endpoint).map((s) => s.title); };

  assert.deepEqual(await titles(`${dayMinus(7)}T09:59`), []);
  assert.deepEqual(await titles(`${dayMinus(7)}T10:00`), ['Next week: Diwali Remind']);
  assert.match(sent[0].body, /^[A-Z][a-z]{2} \d{1,2}, \d{4}, 5:00 PM/, 'names the date');
  assert.deepEqual(await titles(`${dayMinus(7)}T15:00`), [], 'once');
  assert.deepEqual(await titles(`${dayMinus(1)}T17:59`), []);
  assert.deepEqual(await titles(`${dayMinus(1)}T18:00`), ['Tomorrow: Diwali Remind']);
  assert.deepEqual(await titles(`${day}T08:29`), []);
  assert.deepEqual(await titles(`${day}T08:30`), ['Today: Diwali Remind']);

  // Switched off on the event: no morning-of reminder.
  const quiet = await t.createEvent(admin, { title: 'Quiet Meeting', starts_at: `${day}T19:00`, remind_day_of: '' });
  await m.post(`/events/${quiet}/rsvp`, { party_size: '1' });
  assert.equal(reminders.dueReminders(t.db, `${day}T12:00`).filter((d) => d.rsvp.event_id === quiet).length, 0);

  // The committee sees the plan on the event page and in the form.
  const page = (await admin.get(`/admin/events/${ev}`)).text;
  assert.match(page, /Phone reminders: a week before at 10:00 AM · the day before at 6:00 PM · the morning of at 8:30 AM/);
  const form = (await admin.get(`/admin/events/${ev}/edit`)).text;
  assert.match(form, /name="remind_week_before" value="1" checked[\s\S]*name="remind_week_before_time" value="10:00"/);
  assert.match((await admin.get(`/admin/events/${quiet}`)).text, /Phone reminders: off/);
  assert.match((await admin.get('/admin/events/new')).text, /name="remind_day_of" value="1" checked/, 'new events remind the morning of by default');
});

test('an "RSVP now" invitation goes once to members with reminders on whose family has no ticket', async () => {
  const day = t.futureDate(30).slice(0, 10);
  const inviteDay = t.futureDate(25).slice(0, 10);
  let res = await admin.follow(await admin.post('/admin/events', { title: 'Too Late Invite', starts_at: `${day}T18:00`, max_party_size: '6', status: 'published', invite: '1', invite_at: `${day}T19:00` }));
  assert.match(res.text, /has to go out before the event starts/);
  const ev = await t.createEvent(admin, { title: 'Kite Festival Invite', starts_at: `${day}T11:00`, invite: '1', invite_at: `${inviteDay}T10:00` });

  const going = await t.register('going-i@test.org', 'Gopi');
  await going.post(`/events/${ev}/rsvp`, { party_size: '1' });
  await going.post('/reminders/subscribe', device(30));
  const invitee = await t.register('invitee-i@test.org', 'Indu');
  await invitee.post('/reminders/subscribe', device(31));
  const noDevice = await t.register('nodevice-i@test.org', 'Nayan'); // reminders not turned on: nothing to send to
  void noDevice;

  // (People from earlier tests have reminders on too; this looks at the two set up here.)
  const ours = [userId('going-i@test.org'), userId('invitee-i@test.org')];
  const invited = (now) => reminders.dueInvites(t.db, now).filter((d) => d.event.id === ev && ours.includes(d.userId)).map((d) => d.userId);
  assert.deepEqual(invited(`${inviteDay}T09:59`), []);
  assert.deepEqual(invited(`${inviteDay}T10:00`), [userId('invitee-i@test.org')]);
  sent.length = 0;
  await reminders.sendDue(t.db, `${inviteDay}T10:05`);
  const msg = sent.find((s) => s.endpoint === device(31).endpoint);
  assert.equal(msg.title, 'RSVP now: Kite Festival Invite');
  assert.equal(msg.url, `/events/${ev}`);
  assert.match(msg.body, /Tap to RSVP\.$/);
  assert.equal(sent.filter((s) => s.endpoint === device(30).endpoint).length, 0, 'already has a ticket');
  assert.deepEqual(invited(`${inviteDay}T12:00`), [], 'once');
  assert.match((await admin.get(`/admin/events/${ev}`)).text, /RSVP invitation [^<]*\(sent to \d+\)/);

  // Members-only events invite only paid members.
  const club = await t.createEvent(admin, { title: 'Members AGM Invite', starts_at: `${day}T14:00`, members_only: '1', invite: '1', invite_at: `${inviteDay}T10:00` });
  assert.ok(!reminders.dueInvites(t.db, `${inviteDay}T11:00`).some((d) => d.event.id === club && d.userId === userId('invitee-i@test.org')));
});

test('every event has an RSVP invitation: a week before at 10 AM unless chosen, right away when sooner, never a day late', async () => {
  const far = t.futureDate(20).slice(0, 10);
  const ev = await t.createEvent(admin, { title: 'Default Invite', starts_at: `${far}T18:00` });
  const weekBefore = new Date(Date.parse(`${far}T12:00:00Z`) - 7 * 86400000).toISOString().slice(0, 10);
  assert.equal(t.db.prepare('SELECT invite_at FROM events WHERE id = ?').get(ev).invite_at, `${weekBefore}T10:00`);
  // Less than a week off: the next quarter hour.
  const soon = await t.createEvent(admin, { title: 'Soon Invite', starts_at: t.futureDate(2) });
  const at = t.db.prepare('SELECT invite_at FROM events WHERE id = ?').get(soon).invite_at;
  assert.ok(at >= nowLocal().slice(0, 16) && at <= `${t.futureDate(0).slice(0, 10)}T23:59`, at);
  // Chosen time kept.
  const chosen = await t.createEvent(admin, { title: 'Chosen Invite', starts_at: `${far}T18:00`, invite_at: `${weekBefore}T08:15` });
  assert.equal(t.db.prepare('SELECT invite_at FROM events WHERE id = ?').get(chosen).invite_at, `${weekBefore}T08:15`);
  // No checkbox to turn it off.
  const form = (await admin.get(`/admin/events/${ev}/edit`)).text;
  assert.doesNotMatch(form, /name="invite"/);
  assert.match(form, new RegExp(`name="invite_at" value="${weekBefore}T10:00"`));
  // Not sent more than a day late.
  const m = await t.register('late-i@test.org', 'Lata');
  await m.post('/reminders/subscribe', device(40));
  const late = (now) => reminders.dueInvites(t.db, now).some((d) => d.event.id === ev && d.userId === userId('late-i@test.org'));
  assert.ok(late(`${weekBefore}T10:00`));
  const next = new Date(Date.parse(`${weekBefore}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  assert.ok(late(`${next}T09:59`), 'within a day');
  assert.ok(!late(`${next}T10:01`), 'more than a day late');
});

test('the push keys come from the app secret, so they survive the server starting over with an empty database', () => {
  const { DatabaseSync } = require('node:sqlite');
  const fresh = () => { const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)'); return db; };
  const config = { sessionSecret: 'render-generated-secret' };
  const a = reminders.vapidKeys(fresh(), config);
  assert.deepEqual(reminders.vapidKeys(fresh(), config), a, 'same keys after a restart');
  assert.notDeepEqual(reminders.vapidKeys(fresh(), { sessionSecret: 'another-secret' }), a);
  assert.notDeepEqual(reminders.vapidKeys(fresh(), {}), a, 'no secret: made at random');
  assert.doesNotThrow(() => require('web-push').setVapidDetails('mailto:x@example.com', a.publicKey, a.privateKey));
  reminders.setup(t.db, t.config()); // back to the test server's keys
});
