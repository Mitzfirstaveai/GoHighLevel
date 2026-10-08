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

test('tickets show a short code the door can type when the QR code will not scan', async () => {
  const { shortCode } = require('../src/services');
  const eventId = await t.createEvent(admin, { title: 'Sharad Purnima', starts_at: t.futureDate(2) });
  const m = await t.register('shortcode@test.org', 'Short', 3);
  await m.post(`/events/${eventId}/rsvp`, { party_size: '4' });
  const before = t.rsvpFor(eventId, 'shortcode@test.org');
  const code = shortCode(before.qr_token);
  assert.match(code, /^[2-9A-HJKMNP-Z]{3}-[2-9A-HJKMNP-Z]{3}$/, 'no 0/O or 1/I/L');
  assert.match((await m.get(`/tickets/${before.id}`)).text, new RegExp(`<p class="ticket-code">Ticket code <strong>${code}</strong></p>`));

  // The downloaded QR image has the code underneath it too (a 150px band below the 600px QR code).
  const png = await fetch(`${t.base}/tickets/${before.id}/qr.png`, { headers: { cookie: m.cookie } });
  assert.equal(png.headers.get('content-type'), 'image/png');
  const sharp = require('sharp');
  const img = sharp(Buffer.from(await png.arrayBuffer()));
  assert.deepEqual([(await img.metadata()).width, (await img.metadata()).height], [600, 750]);
  const band = await img.extract({ left: 0, top: 640, width: 600, height: 110 }).stats();
  assert.ok(band.channels[0].min < 50, 'dark code letters drawn below the QR code');

  // Typed at the door: any case, with or without the dash.
  for (const typed of [code, code.toLowerCase(), code.replace('-', ''), ` ${code.replace('-', ' ')} `]) {
    const res = await admin.post('/admin/checkin/lookup', { code: typed });
    assert.equal(res.location, `/admin/checkin/${before.qr_token}`, typed);
  }

  // Changing who's coming gives a new QR code and a new short code; the old one shows as replaced.
  await m.post(`/events/${eventId}/rsvp`, { party_size: '2' });
  const after = t.rsvpFor(eventId, 'shortcode@test.org');
  assert.notEqual(shortCode(after.qr_token), code);
  let res = await admin.follow(await admin.post('/admin/checkin/lookup', { code }));
  assert.match(res.text, /Old QR code — replaced/);
  res = await admin.post('/admin/checkin/lookup', { code: shortCode(after.qr_token) });
  assert.equal(res.location, `/admin/checkin/${after.qr_token}`);

  res = await admin.follow(await admin.post('/admin/checkin/lookup', { code: 'ZZZ-ZZZ' }));
  assert.match(res.text, /No ticket with code ZZZ-ZZZ for this week&#39;s events/);
});
