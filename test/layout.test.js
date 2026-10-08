// Fixes from the full phone/laptop check: readable calendar on phones, same-day event times, plan wording.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');
const { grantMembership } = require('../src/services');

let t;
let admin;

before(async () => {
  t = await startTestApp();
  admin = await t.adminLogin();
});
after(() => t.close());

test("the calendar lists the month's events in full for phones, with 12-hour times", async () => {
  const starts = t.futureDate(3, '19:30');
  const id = await t.createEvent(admin, { title: 'Sharad Purnima Garba', starts_at: starts, ends_at: starts.replace('19:30', '23:00') });
  const m = await t.register('calendar@test.org');
  const res = await m.get(`/events?view=calendar&month=${starts.slice(0, 7)}`);
  assert.match(res.text, /class="cal-event[^"]*"[^>]*>7:30 PM Sharad Purnima Garba</);
  assert.match(res.text, new RegExp(`<div class="cal-list event-list">[\\s\\S]*?href="/events/${id}"[\\s\\S]*?Sharad Purnima Garba[\\s\\S]*?7:30 PM`));

  // Same-day events show the end time only: "7:30 PM – 11:00 PM".
  const page = await m.get(`/events/${id}`);
  assert.match(page.text, /When:<\/strong> [^<]*7:30 PM – 11:00 PM<\/p>/);
});

test('a level named "... Membership" is not doubled in messages ("Your Individual membership covers…")', async () => {
  t.db.prepare(`UPDATE membership_plans SET name = 'Individual Membership' WHERE name = 'Individual'`).run();
  const m = await t.register('solo@test.org', 'Solo');
  const id = t.db.prepare(`SELECT id FROM users WHERE email = 'solo@test.org'`).get().id;
  grantMembership(t.db, { userId: id, planId: t.planId('Individual Membership') });
  const res = await m.follow(await m.post('/profile/household', { name: 'Asha', relationship: 'Spouse' }));
  assert.match(res.text, /Your Individual membership covers you only, so Asha can&#39;t be added/);
  assert.match((await m.get('/profile')).text, /Your Individual membership covers you only\./);
});

test('the phone bottom bar uses the top menu names and includes Donate', async () => {
  const m = await t.register('bottombar@test.org');
  const res = await m.get('/donate');
  const bar = res.text.split('<nav class="tabbar')[1].split('</nav>')[0];
  const labels = [...bar.matchAll(/<span>([^<]+)<\/span>/g)].map((x) => x[1].replace('\u00AD', ''));
  assert.deepEqual(labels, ['Home', 'Events', 'My tickets', 'Membership', 'Donate', 'More']);
  assert.match(bar, /class="active"[^>]*>[\s\S]*?<span>Donate<\/span>/);
  // Donate has its own button, so the More page doesn't list it again.
  const more = (await m.get('/more')).text;
  assert.doesNotMatch(more.slice(more.indexOf('<main'), more.indexOf('</main>')), /href="\/donate"/);
});
