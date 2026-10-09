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
  assert.match(res.text, /તમારો આગામી કાર્યક્રમ/);
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

test('light/dark choice: dark by default on every device, then saved for members, admins, volunteers and visitors', async () => {
  const c = await signIn('raj.desai@example.com');
  let res = await c.get('/dashboard');
  assert.match(res.text, /<html lang="en" class="size-normal" data-theme="dark">/, 'no choice yet: dark');
  await c.get('/prefs?theme=light&back=/dashboard');
  assert.match((await c.get('/dashboard')).text, /data-theme="light"/);
  // Both switches are sent; the stylesheet shows the one that fits the colors on screen.
  assert.match(res.text, /class="pref-btn theme-btn to-dark" href="\/prefs\?theme=dark/);
  assert.match(res.text, /class="pref-btn theme-btn to-light" href="\/prefs\?theme=light/);
  await c.get('/prefs?theme=dark&back=/dashboard');
  assert.match((await c.get('/dashboard')).text, /<html lang="en" class="size-normal" data-theme="dark">/);
  assert.equal(t.db.prepare(`SELECT theme FROM users WHERE email = 'raj.desai@example.com'`).get().theme, 'dark');
  // The Profile settings offer the three choices, with the current one ticked.
  res = await c.get('/profile');
  assert.match(res.text, /class="choice on" href="\/prefs\?theme=dark/);
  assert.match(res.text, /href="\/prefs\?theme=auto[^"]*">Same as my phone/);
  await c.get('/prefs?theme=nonsense&back=/dashboard'); // ignored
  assert.match((await c.get('/dashboard')).text, /data-theme="dark"/);
  // "Same as my phone" leaves it to the phone's own setting.
  await c.get('/prefs?theme=auto&back=/dashboard');
  assert.doesNotMatch((await c.get('/dashboard')).text, /data-theme=/);

  // Admin area and door check-in have the switch too.
  const admin = await t.adminLogin('admin@example.com', 'demo1234');
  res = await admin.get('/admin');
  assert.match(res.text, /theme-btn to-dark/);
  await admin.get('/prefs?theme=light&back=/admin');
  assert.match((await admin.get('/admin/members')).text, /data-theme="light"/);
  await admin.get('/prefs?theme=auto&back=/admin');

  // Visitors (e.g. the committee & volunteer sign-in page) keep their choice in a cookie.
  const v = new t.Client();
  assert.match((await v.get('/admin/login')).text, /data-theme="dark"[\s\S]*theme-btn to-light/);
  assert.match((await v.get('/')).text, /data-theme="dark"/);
  await v.get('/prefs?theme=light&back=/admin/login');
  assert.match((await v.get('/admin/login')).text, /data-theme="light"/);
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
  let res = await c.follow(await c.post('/profile/household', { name: 'Papa', relationship: 'Father', birth_month: '4', birth_year: '1980' }));
  assert.match(res.text, /તમારા પરિવાર સભ્યપદમાં તમે, તમારા જીવનસાથી અને તમારાં અપરિણીત બાળકો સમાવિષ્ટ છે, એટલે Papaને ઉમેરી શકાશે નહીં/);
  assert.match(res.text, /માતા-પિતા સાથે પરિવારમાં અપગ્રેડ કરો/);
  res = await c.follow(await c.post('/profile/household', { name: 'Nisha', relationship: 'Spouse', birth_month: '4', birth_year: '1980' }));
  assert.doesNotMatch(res.text, /class="flash error"[^<]*[A-Za-z]{6}/); // no English error text
  res = await c.get('/no-such-page');
  assert.match(res.text, /આ પેજ અસ્તિત્વમાં નથી/);
  await c.get('/prefs?lang=en&back=/');
});

// Gujarati pages use full month and weekday names and Gujarati times of day — never the
// shortened forms ("ઑક્ટો", "ગુરુ") or English AM/PM. (Names are checked against the browser's own list.)
const SHORT_GU = [
  ...[...Array(12)].map((_, m) => new Date(Date.UTC(2026, m, 15))).flatMap((d) => [
    d.toLocaleString('gu-IN', { month: 'short', timeZone: 'UTC' }), d.toLocaleString('gu-IN', { month: 'long', timeZone: 'UTC' })]),
].reduce((out, name, i, all) => (i % 2 === 0 && name !== all[i + 1] ? [...out, name] : out), []);
const SHORT_DAYS = [...Array(7)].map((_, i) => new Date(Date.UTC(2026, 0, 4 + i)).toLocaleString('gu-IN', { weekday: 'short', timeZone: 'UTC' }));
function assertNoShortDates(html, page) {
  const text = html.replace(/<[^>]+>/g, ' ');
  for (const short of SHORT_GU) assert.doesNotMatch(text, new RegExp(`${short}(?![\\u0A80-\\u0AFF])`), `${page}: shortened month "${short}"`);
  for (const day of SHORT_DAYS) assert.doesNotMatch(text, new RegExp(`(^|[^\\u0A80-\\u0AFF])${day}(?![\\u0A80-\\u0AFF])`), `${page}: shortened weekday "${day}"`);
  assert.doesNotMatch(text, /\d (AM|PM)\b/, `${page}: English AM/PM`);
}

test('dates read naturally in each language', () => {
  const { formatDateTime } = require('../src/util');
  assert.equal(formatDateTime('2026-10-08T19:30', 'en-US'), 'Oct 8, 2026, 7:30 PM');
  assert.equal(formatDateTime('2026-10-08', 'en-US'), 'Oct 8, 2026');
  assert.equal(formatDateTime('2026-10-08T19:30', 'gu-IN'), '8 ઑક્ટોબર, 2026, સાંજે 7:30');
  assert.equal(formatDateTime('2026-10-08T09:00', 'gu-IN'), '8 ઑક્ટોબર, 2026, સવારે 9:00');
  assert.equal(formatDateTime('2026-09-01', 'gu-IN'), '1 સપ્ટેમ્બર, 2026');
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
  // Two sample stories so the Gujarat & India news page and the home-page headlines show their labels.
  const src = (url) => db.prepare('SELECT id FROM news_sources WHERE url LIKE ?').get(`%${url}%`).id;
  db.prepare(`INSERT INTO news_items (source_id, guid, title, summary, link, published_at) VALUES (?, 'g1', 'ગુજરાતમાં નવરાત્રિની ધૂમ', 'ગરબા', 'https://example.com/1', datetime('now', '-3 hours')),
    (?, 'g2', 'Ahmedabad heritage walk turns 25', 'A short summary.', 'https://example.com/2', datetime('now', '-2 days'))`).run(src('bbci'), src('ahmedabad'));
  const pages = ['/dashboard', '/news/india', '/news/india?lang=all', '/events', '/events?view=calendar', `/events/${event('Diwali Dinner & Cultural Program')}`,
    `/events/${event('Garba Dance Workshop for Kids')}`, `/events/${event('Navratri Garba #1')}`, `/events/${event('Annual General Meeting')}`,
    '/tickets', `/tickets/${ticket}`, '/membership', '/profile', '/payments', '/donate', '/directory', '/news', '/more',
    '/photos', '/photos?category=festivals',
    `/photos/albums/${db.prepare('SELECT id FROM photo_albums LIMIT 1').get().id}`,
    `/photos/view/${db.prepare('SELECT id FROM photos WHERE caption IS NOT NULL LIMIT 1').get().id}`,
    '/about', '/committee', '/sponsors', '/contact'];
  for (const p of pages) {
    const res = await c.get(p);
    assert.equal(res.status, 200, p);
    assertNoShortDates(res.text, p);
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
  // Garba costs $5 now; paying at the door gives the ticket straight away.
  const res = await c.follow(await c.post(`/events/${garba}/rsvp`, { choose: '1', people: `h:${amit}`, pay: 'door' }));
  assert.match(res.text, /આ ટિકિટ આમના માટે છે/);
  await c.get('/tickets');
  // Priya makes an invite link for Diya; Diya opens it (signed out), and Amit (signed in) opens it too.
  const priya = await signIn('member@example.com');
  await priya.get('/prefs?lang=gu&back=/');
  const diya = db.prepare(`SELECT h.id FROM household_members h JOIN users u ON u.id = h.user_id WHERE u.email = 'member@example.com' AND h.name = 'Diya Shah'`).get().id;
  assert.match((await priya.follow(await priya.post(`/profile/household/${diya}/invite`, {}))).text, /WhatsApp/);
  const token = db.prepare('SELECT invite_token FROM household_members WHERE id = ?').get(diya).invite_token;
  const anon = new t.Client();
  await anon.get('/prefs?lang=gu&back=/');
  assert.equal((await anon.get(`/join/family/${token}`)).status, 200);
  assert.equal((await anon.get('/join/family/not-a-real-invite-token-123')).status, 404);
  await c.get(`/join/family/${token}`);
  await priya.get(`/join/family/${token}`);
  await priya.post(`/profile/household/${diya}/invite/cancel`, {});
  assert.deepEqual([...missing], [], `Untranslated text: ${[...missing].join(' | ')}`);
  await c.get('/prefs?lang=en&back=/');
  await priya.get('/prefs?lang=en&back=/');
});

test('dictionary placeholders match the English text', () => {
  for (const [en, g] of Object.entries(gu)) {
    const a = (en.match(/\{\w+\}/g) || []).sort().join();
    const b = (g.match(/\{\w+\}/g) || []).sort().join();
    assert.equal(b, a, `Placeholder mismatch for "${en}"`);
  }
});

test('the admin area stays in English for the committee', async () => {
  const c = await t.adminLogin('admin@example.com', 'demo1234');
  await c.get('/prefs?lang=gu&back=/admin');
  const res = await c.get('/admin/members');
  assert.match(res.text, /Members \(\d+\)/);
  assert.match(res.text, /<nav class="subnav[^"]*" aria-label="Admin" lang="en">/);
  await c.get('/prefs?lang=en&back=/');
});
