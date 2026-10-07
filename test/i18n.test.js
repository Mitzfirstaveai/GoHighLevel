const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');
const { missing } = require('../src/i18n');
const gu = require('../src/locales/gu');

let t;

// The demo data has every kind of content (Gujarati event names, waitlists, donations…).
before(async () => { t = await startTestApp({ demoMode: true, adminEmail: '', orgName: 'Gujarati Samaj of Arkansas' }); });
after(() => t.close());

async function signIn(email) {
  const c = new t.Client();
  await c.get('/login');
  const res = await c.post('/login', { email, password: 'demo1234' });
  assert.equal(res.status, 302);
  await c.get('/dashboard');
  return c;
}

test('language button switches to Gujarati and remembers it on the profile', async () => {
  const c = await signIn('member@example.com');
  let res = await c.get('/dashboard');
  assert.match(res.text, /<html lang="en"/);
  assert.match(res.text, />ગુજરાતી<\/a>/); // the button offers Gujarati

  res = await c.get('/prefs?lang=gu&back=%2Fdashboard');
  assert.equal(res.location, '/dashboard');
  res = await c.get('/dashboard');
  assert.match(res.text, /<html lang="gu"/);
  assert.match(res.text, /નમસ્તે, Priya/);
  assert.match(res.text, /મારી QR ટિકિટો/);
  assert.match(res.text, /નવરાત્રી ગરબા #1/); // Gujarati event title
  assert.match(res.text, />English<\/a>/);
  assert.equal(t.db.prepare(`SELECT language FROM users WHERE email = 'member@example.com'`).get().language, 'gu');

  // Saved on the profile: a new phone (no cookie) opens in Gujarati after signing in.
  const other = await signIn('member@example.com');
  assert.match((await other.get('/events')).text, /આગામી કાર્યક્રમો/);
  await other.get('/prefs?lang=en&back=/');
});

test('text size setting is saved and applied', async () => {
  const c = await signIn('raj.desai@example.com');
  let res = await c.get('/dashboard');
  assert.match(res.text, /class="size-normal"/);
  await c.get('/prefs?size=next&back=/dashboard');
  assert.match((await c.get('/dashboard')).text, /class="size-large"/);
  await c.get('/prefs?size=xlarge&back=/dashboard');
  assert.match((await c.get('/more')).text, /class="size-xlarge"/);
  assert.equal(t.db.prepare(`SELECT text_size FROM users WHERE email = 'raj.desai@example.com'`).get().text_size, 'xlarge');
  // Unsafe "back" targets are ignored.
  res = await c.get('/prefs?size=normal&back=//evil.example');
  assert.equal(res.location, '/');
});

test('visitors can switch language before signing in', async () => {
  const c = new t.Client();
  await c.get('/prefs?lang=gu&back=/');
  const res = await c.get('/');
  assert.match(res.text, /ગુજરાતી સમાજ ઓફ અરકાન્સાસમાં આપનું સ્વાગત છે/);
  assert.match(res.text, /સાથે મળીને, વધુ સારી સેવા/);
  assert.match((await c.get('/about')).text, /ગુજરાતી સમાજ ઓફ અરકાન્સાસ \(GSA\)ની સ્થાપના 1989માં/);
  assert.match((await c.get('/committee')).text, /અધ્યક્ષા/);
  assert.match((await c.get('/login')).text, /પાસવર્ડ/);
});

test('messages and errors appear in Gujarati', async () => {
  const c = await signIn('member@example.com');
  await c.get('/prefs?lang=gu&back=/');
  // Family level does not cover parents: the refusal is translated, including the level names.
  let res = await c.follow(await c.post('/profile/household', { name: 'Papa', relationship: 'Father' }));
  assert.match(res.text, /તમારા પરિવાર સભ્યપદમાં તમે, તમારા જીવનસાથી અને તમારાં અપરિણીત બાળકો સમાવિષ્ટ છે, એટલે Papaને ઉમેરી શકાશે નહીં/);
  assert.match(res.text, /માતા-પિતા સાથે પરિવારમાં અપગ્રેડ કરો/);
  res = await c.follow(await c.post('/profile/household', { name: 'Nisha', relationship: 'Spouse' }));
  assert.doesNotMatch(res.text, /class="flash error"[^<]*[A-Za-z]{6}/); // no English error text
  res = await c.get('/no-such-page');
  assert.match(res.text, /આ પેજ અસ્તિત્વમાં નથી/);
  await c.get('/prefs?lang=en&back=/');
});

test('every member and public page is fully translated', async () => {
  const c = await signIn('member@example.com');
  await c.get('/prefs?lang=gu&back=/');
  const { db } = t;
  const event = (title) => db.prepare('SELECT id FROM events WHERE title = ?').get(title).id;
  const ticket = db.prepare(`SELECT r.id FROM rsvps r JOIN users u ON u.id = r.user_id WHERE u.email = 'member@example.com' AND r.status = 'confirmed' LIMIT 1`).get().id;
  missing.clear();
  // Exercise the states that show the most text: a paid event with questions and guests, a full event, a ticket.
  await c.post(`/events/${event('Diwali Dinner & Cultural Program')}/rsvp`, { party_size: '2', guests: '1', q_0: 'Jain', coupon: 'DIWALI10' });
  await c.post(`/events/${event('Garba Dance Workshop for Kids')}/rsvp`, { party_size: '1', waitlist: '1' });
  const pages = ['/dashboard', '/events', '/events?view=calendar', `/events/${event('Diwali Dinner & Cultural Program')}`,
    `/events/${event('Garba Dance Workshop for Kids')}`, `/events/${event('Navratri Garba #1')}`, `/events/${event('Annual General Meeting')}`,
    '/tickets', `/tickets/${ticket}`, '/membership', '/profile', '/payments', '/donate', '/directory', '/news', '/more',
    '/photos', '/photos?category=festivals',
    `/photos/albums/${db.prepare('SELECT id FROM photo_albums LIMIT 1').get().id}`,
    `/photos/view/${db.prepare('SELECT id FROM photos WHERE caption IS NOT NULL LIMIT 1').get().id}`,
    '/about', '/committee', '/sponsors', '/contact'];
  for (const p of pages) {
    const res = await c.get(p);
    assert.equal(res.status, 200, p);
  }
  const pay = db.prepare(`SELECT id FROM payments WHERE status = 'paid' AND user_id = (SELECT id FROM users WHERE email = 'member@example.com') LIMIT 1`).get().id;
  assert.equal((await c.get(`/receipts/${pay}`)).status, 200);
  const anon = new t.Client();
  await anon.get('/prefs?lang=gu&back=/');
  for (const p of ['/', '/login', '/register']) await anon.get(p);
  assert.deepEqual([...missing], [], `Untranslated text: ${[...missing].join(' | ')}`);
});

test('family-login screens are fully translated', async () => {
  const c = await signIn('amit.shah@example.com');
  await c.get('/prefs?lang=gu&back=/');
  const { db } = t;
  const garba = db.prepare(`SELECT id FROM events WHERE title = 'Navratri Garba #1'`).get().id;
  const priyasTicket = db.prepare(`SELECT r.id FROM rsvps r JOIN users u ON u.id = r.user_id WHERE u.email = 'member@example.com' AND r.event_id = ?`).get(garba).id;
  missing.clear();
  for (const p of ['/dashboard', '/profile', '/membership', '/tickets', `/events/${garba}`, `/tickets/${priyasTicket}`]) {
    assert.equal((await c.get(p)).status, 200, p);
  }
  // Amit adds himself (Priya's ticket is for her and the kids), then sees his own ticket.
  const amit = db.prepare(`SELECT h.id FROM household_members h JOIN users u ON u.id = h.login_user_id WHERE u.email = 'amit.shah@example.com'`).get().id;
  const res = await c.follow(await c.post(`/events/${garba}/rsvp`, { choose: '1', people: `h:${amit}` }));
  assert.match(res.text, /આ ટિકિટ આમના માટે છે/);
  await c.get('/tickets');
  assert.deepEqual([...missing], [], `Untranslated text: ${[...missing].join(' | ')}`);
  await c.get('/prefs?lang=en&back=/');
});

test('dictionary placeholders match the English text', () => {
  for (const [en, g] of Object.entries(gu)) {
    const a = (en.match(/\{\w+\}/g) || []).sort().join();
    const b = (g.match(/\{\w+\}/g) || []).sort().join();
    assert.equal(b, a, `Placeholder mismatch for "${en}"`);
  }
});

test('the admin area stays in English for the committee', async () => {
  const c = await signIn('admin@example.com');
  await c.get('/prefs?lang=gu&back=/');
  const res = await c.get('/admin/members');
  assert.match(res.text, /Contacts \(\d+\)/);
  assert.match(res.text, /<nav class="subnav" aria-label="Admin" lang="en">/);
  await c.get('/prefs?lang=en&back=/');
});
