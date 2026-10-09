// GSA announcements made by the events themselves: "Coming up" from the RSVP invitation date, then
// "Tomorrow", "Today" and "Happening now", with the committee's own message; switched off per event.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');
const svc = require('../src/services');

let t;
let admin;
before(async () => { t = await startTestApp(); admin = await t.adminLogin(); });
after(() => t.close());

const day = (n) => t.futureDate(n).slice(0, 10);
const titles = (list) => list.map((a) => `${a.when}:${a.event.title}`);

test('an event announces itself from its invitation date until it ends, then says Tomorrow, Today and Happening now', async () => {
  const ev = await t.createEvent(admin, { title: 'Sharad Purnima Garba', starts_at: `${day(9)}T19:30`, ends_at: `${day(9)}T23:00`,
    invite_at: `${day(2)}T10:00`, announce_note: 'Bring a dish of doodh pauva to share!' });
  const mine = (now) => titles(svc.eventAnnouncements(t.db, null, now)).filter((x) => x.endsWith('Sharad Purnima Garba'));
  assert.deepEqual(mine(`${day(1)}T23:59`), [], 'not before the invitation day');
  assert.deepEqual(mine(`${day(2)}T00:00`), ['soon:Sharad Purnima Garba'], 'from the start of the invitation day');
  assert.deepEqual(mine(`${day(8)}T08:00`), ['tomorrow:Sharad Purnima Garba']);
  assert.deepEqual(mine(`${day(9)}T08:00`), ['today:Sharad Purnima Garba']);
  assert.deepEqual(mine(`${day(9)}T20:00`), ['now:Sharad Purnima Garba']);
  assert.deepEqual(mine(`${day(9)}T23:00`), [], 'gone once it ends');

  // On the member's Home and the All announcements page, with the committee's message and what to do.
  t.db.prepare('UPDATE events SET invite_at = ? WHERE id = ?').run('2000-01-01T10:00', ev);
  const m = await t.register('announce@test.org', 'Asha');
  let home = (await m.get('/dashboard')).text;
  assert.match(home, /GSA announcements[\s\S]*Coming up: Sharad Purnima Garba[\s\S]*Bring a dish of doodh pauva to share![\s\S]*Tap to RSVP\./);
  assert.match((await m.get('/news')).text, /Events coming up[\s\S]*Coming up: Sharad Purnima Garba/);
  // With a ticket, it points to the QR ticket instead.
  await m.post(`/events/${ev}/rsvp`, { party_size: '1' });
  home = (await m.get('/dashboard')).text;
  assert.match(home, /href="\/tickets"[^>]*>[\s\S]*?Coming up: Sharad Purnima Garba[\s\S]*?Tap to open your QR ticket\./);
  // In Gujarati: the heading and the committee's Gujarati message.
  t.db.prepare('UPDATE events SET announce_note_gu = ? WHERE id = ?').run('દૂધ પૌંઆ લાવજો!', ev);
  await m.get('/prefs?lang=gu&back=/');
  assert.match((await m.get('/dashboard')).text, /આગામી: Sharad Purnima Garba[\s\S]*દૂધ પૌંઆ લાવજો!/);
});

test('the committee can switch an announcement off or add to it; drafts and cancelled events are never announced', async () => {
  const ev = await t.createEvent(admin, { title: 'Quiet Meeting', starts_at: `${day(3)}T18:00`, announce: '' });
  const draft = await t.createEvent(admin, { title: 'Draft Picnic', starts_at: `${day(3)}T12:00`, status: 'draft' });
  const gone = await t.createEvent(admin, { title: 'Cancelled Raas', starts_at: `${day(3)}T19:00`, status: 'cancelled' });
  const shown = () => svc.eventAnnouncements(t.db, null).map((a) => a.event.id);
  for (const id of [ev, draft, gone]) assert.ok(!shown().includes(id));
  assert.match((await admin.get(`/admin/events/${ev}`)).text, /GSA announcements: off/);

  // Turned on with a message from the edit page.
  const form = (await admin.get(`/admin/events/${ev}/edit`)).text;
  assert.match(form, /name="announce" value="1" >/, 'unticked when off');
  const fields = { title: 'Quiet Meeting', starts_at: `${day(3)}T18:00`, fee: '0', max_party_size: '6', status: 'published',
    announce: '1', announce_note: 'Snacks provided.' };
  assert.equal((await admin.post(`/admin/events/${ev}`, fields)).status, 302);
  assert.ok(shown().includes(ev));
  assert.match((await admin.get(`/admin/events/${ev}`)).text, /GSA announcements: from .+ until it ends, with your message/);
  // A new event's form has it ticked.
  assert.match((await admin.get('/admin/events/new')).text, /name="announce" value="1" checked/);
});
