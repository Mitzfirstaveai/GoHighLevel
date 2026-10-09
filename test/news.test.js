// Gujarat & India news (headlines from outside feeds) and Celebrations (shared birthdays and anniversaries).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');
const newsfeed = require('../src/newsfeed');
const { NEWS_FILTER } = require('../src/content');
const svc = require('../src/services');

let t;
let admin;

before(async () => {
  t = await startTestApp();
  admin = await t.adminLogin();
});
after(() => t.close());

const LONG = 'Thousands of families gathered at the riverfront for garba. '.repeat(20);
const RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>Sample</title>
<item><title><![CDATA[Navratri lights up Ahmedabad &amp; Vadodara]]></title><link>https://news.example.com/a?x=1&amp;y=2</link>
  <description><![CDATA[<p>${LONG}</p><script>alert(1)</script><img src="x.jpg">]]></description>
  <pubDate>Wed, 07 Oct 2026 10:00:00 +0530</pubDate><guid>story-a</guid></item>
<item><title>Voters queue up in Surat</title><link>https://news.example.com/b</link><description>Polling day.</description><guid>story-b</guid></item>
<item><title>Sneaky link</title><link>javascript:alert(1)</link><guid>story-c</guid></item>
<item><title>Escaped &lt;b&gt;markup&lt;/b&gt; &#8211; handled</title><link>https://news.example.com/d</link>
  <description>&lt;p&gt;Rain &amp;amp; relief for farmers in Saurashtra.&lt;/p&gt;</description><guid>story-d</guid></item>
</channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>ગુજરાતમાં સારો વરસાદ</title>
  <link rel="alternate" href="https://gu.example.com/1"/><id>tag:gu-1</id><updated>2026-10-06T08:00:00Z</updated><summary>ખેડૂતો ખુશ છે.</summary></entry></feed>`;

test('feeds are read safely: plain text only, ordinary web links only, a short summary', () => {
  const items = newsfeed.parseFeed(RSS, new Date('2026-10-08T12:00:00Z'));
  assert.deepEqual(items.map((i) => i.guid), ['story-a', 'story-b', 'story-d'], 'the javascript: link is dropped');
  const [a, , d] = items;
  assert.equal(a.title, 'Navratri lights up Ahmedabad & Vadodara');
  assert.equal(a.link, 'https://news.example.com/a?x=1&y=2');
  assert.equal(a.published, '2026-10-07 04:30:00');
  assert.ok(a.summary.length <= 700 && a.summary.length > 300, 'a quick read, not the whole article');
  assert.doesNotMatch(a.summary, /<|alert|script/);
  assert.equal(d.title, 'Escaped markup – handled');
  assert.equal(d.summary, 'Rain & relief for farmers in Saurashtra.');
  const [g] = newsfeed.parseFeed(ATOM);
  assert.deepEqual([g.title, g.link, g.summary], ['ગુજરાતમાં સારો વરસાદ', 'https://gu.example.com/1', 'ખેડૂતો ખુશ છે.']);
});

test('the filter keeps out US politics, elections and distressing stories, without false alarms', () => {
  const hit = (title) => newsfeed.filterMatch({ title, summary: '' }, NEWS_FILTER);
  for (const title of ['Trump says…', 'Voters queue up', 'BJP and Congress trade barbs', 'ચૂંટણીની તારીખો જાહેર', 'Exit poll results',
    'Man killed in accident', 'White House statement']) assert.ok(hit(title), title);
  for (const title of ['Trumpet recital at Sabarmati', 'Map of new metro line', 'Pollution drops in Ahmedabad', 'India beat Australia',
    'Garba classes begin']) assert.equal(hit(title), null, title);
});

test('admins can only add public news websites', () => {
  for (const url of ['http://localhost:3000/feed', 'https://10.0.0.5/rss', 'file:///etc/passwd', 'ftp://x.com/a', 'intranet/feed']) {
    assert.ok(newsfeed.feedUrlProblem(url), url);
  }
  assert.equal(newsfeed.feedUrlProblem('https://www.thehindu.com/news/national/feeder/default.rss'), null);
});

// A stand-in for the news websites (the test never goes on the internet).
function fakeFetch(feeds) {
  return async (url) => (feeds[url] ? new Response(feeds[url], { status: 200 }) : new Response('nope', { status: 404 }));
}

test('fetching saves stories and records whether each source works', async () => {
  const { db } = t;
  const id = Number(db.prepare(`INSERT INTO news_sources (name, url, lang, topic) VALUES ('Sample Gujarat', 'https://news.example.com/feed', 'en', 'Gujarat')`).run().lastInsertRowid);
  const source = db.prepare('SELECT * FROM news_sources WHERE id = ?').get(id);
  let result = await newsfeed.fetchSource(db, source, { fetchImpl: fakeFetch({ 'https://news.example.com/feed': RSS }) });
  assert.deepEqual(result, { ok: true, count: 3 });
  // Fetching again doesn't duplicate stories.
  await newsfeed.fetchSource(db, source, { fetchImpl: fakeFetch({ 'https://news.example.com/feed': RSS }) });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM news_items WHERE source_id = ?').get(id).n, 3);
  // Redirects are followed only to public websites.
  const redirect = async (url) => (url === 'https://news.example.com/moved'
    ? new Response(null, { status: 301, headers: { location: 'https://news.example.com/feed' } })
    : url === 'https://news.example.com/sneaky' ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3000/admin' } })
    : fakeFetch({ 'https://news.example.com/feed': RSS })(url));
  assert.equal((await newsfeed.fetchSource(db, { ...source, url: 'https://news.example.com/moved' }, { fetchImpl: redirect })).ok, true);
  result = await newsfeed.fetchSource(db, { ...source, url: 'https://news.example.com/sneaky' }, { fetchImpl: redirect });
  assert.match(result.error, /not a computer or IP address/);
  // Oversized feeds are cut off.
  const huge = async () => new Response(`<rss>${'x'.repeat(3.5 * 1024 * 1024)}</rss>`);
  assert.match((await newsfeed.fetchSource(db, source, { fetchImpl: huge })).error, /too large/);
  result = await newsfeed.fetchSource(db, { ...source, url: 'https://news.example.com/missing' }, { fetchImpl: fakeFetch({}) });
  assert.equal(result.ok, false);
  assert.match(db.prepare('SELECT last_error FROM news_sources WHERE id = ?').get(id).last_error, /error 404/);
});

test('members read headlines and quick reads, and open the full story on the newspaper site', async () => {
  const { db } = t;
  const gu = Number(db.prepare(`INSERT INTO news_sources (name, url, lang, topic) VALUES ('Sample ગુજરાતી', 'https://gu.example.com/feed', 'gu', 'India')`).run().lastInsertRowid);
  await newsfeed.fetchSource(db, db.prepare('SELECT * FROM news_sources WHERE id = ?').get(gu), { fetchImpl: fakeFetch({ 'https://gu.example.com/feed': ATOM }) });
  const m = await t.register('reader@test.org', 'Reader');

  let res = await m.get('/news/india');
  assert.match(res.text, /Navratri lights up Ahmedabad &amp; Vadodara/);
  assert.match(res.text, /Thousands of families gathered/);
  assert.match(res.text, /href="https:\/\/news\.example\.com\/a\?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">Read the full story/);
  assert.doesNotMatch(res.text, /Voters queue up/, 'filtered: elections');
  assert.doesNotMatch(res.text, /ગુજરાતમાં સારો વરસાદ/, 'English readers see English sources by default');
  assert.match(res.text, /GSA does not write or endorse these stories/);
  res = await m.get('/news/india?lang=all');
  assert.match(res.text, /ગુજરાતમાં સારો વરસાદ/);
  assert.match((await m.get('/dashboard')).text, /Gujarat &amp; India news[\s\S]*Navratri lights up Ahmedabad/);

  // The committee hides one story and switches a source off; the filter can be changed.
  const story = db.prepare(`SELECT id FROM news_items WHERE guid = 'story-d'`).get().id;
  await admin.post(`/admin/news/items/${story}/hide`, { hidden: '1' });
  assert.doesNotMatch((await m.get('/news/india')).text, /Rain &amp; relief/);
  await admin.post('/admin/news/feeds/filter', { words: 'Navratri\nvote' });
  res = await m.get('/news/india');
  assert.doesNotMatch(res.text, /Navratri lights up/);
  assert.match(res.text, /ગુજરાતમાં સારો વરસાદ/, 'with nothing left in English, both languages are shown');
  await admin.post('/admin/news/feeds/filter', { words: NEWS_FILTER.join('\n') });
  await admin.post(`/admin/news/feeds/${gu}/edit`, { name: 'Sample ગુજરાતી', url: 'https://gu.example.com/feed', lang: 'gu', topic: 'India' }); // no "enabled": off
  res = await m.get('/news/india?lang=all');
  assert.doesNotMatch(res.text, /ગુજરાતમાં સારો વરસાદ/);
  res = await m.get('/news/india?lang=gu');
  assert.doesNotMatch(res.text, /ગુજરાતમાં સારો વરસાદ/);
  assert.match(res.text, /Navratri lights up/, 'no Gujarati stories left, so English ones are shown rather than an empty page');

  // The admin page shows everything, with the reason a story is hidden.
  res = await admin.get('/admin/news/feeds');
  assert.match(res.text, /Voters queue up in Surat[\s\S]*?Filtered out: “vote”/);
  assert.match(res.text, /Hidden by the committee/);
  // Members can't manage news sources.
  assert.equal((await m.post('/admin/news/feeds/filter', { words: '' })).status, 403);
});

test('adding a source checks it straight away; unsafe addresses are refused', async () => {
  const realFetch = global.fetch;
  global.fetch = (url, opts) => (String(url).startsWith('https://added.example.com') ? fakeFetch({ 'https://added.example.com/rss': RSS })(url) : realFetch(url, opts));
  try {
    let res = await admin.follow(await admin.post('/admin/news/feeds', { name: 'Added paper', url: 'https://added.example.com/rss', lang: 'en', topic: 'Gujarat' }));
    assert.match(res.text, /Added paper: working, 3 headlines found/);
    res = await admin.follow(await admin.post('/admin/news/feeds', { name: 'Sneaky', url: 'http://localhost:22/', lang: 'en', topic: 'India' }));
    assert.match(res.text, /not a computer or IP address/);
    assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM news_sources WHERE name = 'Sneaky'`).get().n, 0);
  } finally {
    global.fetch = realFetch;
  }
});

test('celebrations: only what members choose to share, month and day only', async () => {
  const { db } = t;
  const m = await t.register('celebrate@test.org', 'Asha', 0);
  const uid = db.prepare(`SELECT id FROM users WHERE email = 'celebrate@test.org'`).get().id;
  const today = require('../src/util').today();
  const md = (days) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86400000).toISOString().slice(5, 10);
  await m.post('/profile', t.profile({ first_name: 'Asha', last_name: 'Member', birth_year: '1961', birth_month: String(Number(md(0).slice(0, 2))) }));
  await m.post('/profile/household', { name: 'Kiran', relationship: 'Spouse', birth_month: '4', birth_year: '1980' });
  await m.post('/profile/household', { name: 'Tara Member', relationship: 'Daughter', birth_month: String(Number(md(3).slice(0, 2))), birth_year: '2012' });
  const tara = db.prepare(`SELECT id FROM household_members WHERE name = 'Tara Member'`).get().id;

  // Nothing is shown until they choose to share.
  assert.doesNotMatch((await m.get('/news')).text, /Asha Member/);
  const [mm, dd] = md(3).split('-');
  await m.post('/profile/celebrations', {
    birthday_day: String(Number(md(0).slice(3))), share_birthday: '1', anniversary: `1990-${md(1)}`, share_anniversary: '1',
    [`birthday_month_${tara}`]: String(Number(mm)), [`birthday_day_${tara}`]: String(Number(dd)), [`share_birthday_${tara}`]: '1',
  });
  const list = svc.celebrations(db).filter((c) => /Asha|Tara/.test(c.name));
  assert.deepEqual(list.map((c) => [c.kind, c.name, c.inDays]),
    [['birthday', 'Asha Member', 0], ['anniversary', 'Asha & Kiran Member', 1], ['birthday', 'Tara Member', 3]]);

  const other = await t.register('friend@test.org', 'Friend');
  const res = await other.get('/dashboard');
  assert.match(res.text, /Celebrations this week[\s\S]*Asha Member[\s\S]*Happy birthday!/);
  assert.doesNotMatch(res.text, /1961|1990/, 'never a year or an age');
  assert.match((await other.get('/news')).text, /Tara Member/);

  // Unticking stops sharing; family logins can't change the family list.
  await m.post('/profile/celebrations', { anniversary: `1990-${md(1)}` });
  assert.equal(svc.celebrations(db).filter((c) => /Asha|Tara/.test(c.name)).length, 0);
  assert.deepEqual({ ...db.prepare('SELECT share_birthday, share_anniversary FROM users WHERE id = ?').get(uid) }, { share_birthday: 0, share_anniversary: 0 });
});

test('celebrations: members add just the day of their birthday; month and year come from their profile', async () => {
  const { db } = t;
  const m = await t.register('dobhere@test.org', 'Nila', 0);
  const uid = db.prepare(`SELECT id FROM users WHERE email = 'dobhere@test.org'`).get().id;
  const today = require('../src/util').today();
  const [, tm, td] = today.split('-').map(Number);
  await m.post('/profile', t.profile({ first_name: 'Nila', birth_year: '1985', birth_month: String(tm) }));
  const page = (await m.get('/profile')).text;
  // Month and year are shown (fixed here, changed under Personal details); only the day is chosen.
  assert.match(page, /id="celebrations"[\s\S]*class="locked-field"[^>]*>[A-Z][a-z]{2} 1985<\/span>[\s\S]*name="birthday_day"[\s\S]*name="share_birthday"/);
  assert.match(page, new RegExp(`<option value="${new Date(Date.UTC(1985, tm, 0)).getUTCDate()}" *>`));

  // Sharing without a day says what's missing.
  await m.post('/profile/celebrations', { share_birthday: '1' });
  assert.match((await m.get('/profile')).text, /Choose the day of your birthday to share it/);
  assert.equal(db.prepare('SELECT share_birthday FROM users WHERE id = ?').get(uid).share_birthday, 0);

  await m.post('/profile/celebrations', { birthday_day: String(td), share_birthday: '1' });
  assert.deepEqual({ ...db.prepare('SELECT birthday, share_birthday FROM users WHERE id = ?').get(uid) },
    { birthday: today.slice(5), share_birthday: 1 });
  assert.ok(svc.celebrations(db).some((c) => c.name === 'Nila Member' && c.inDays === 0));
  assert.match((await m.get('/profile')).text, new RegExp(`name="birthday_day"[\\s\\S]*?<option value="${td}" selected>`));

  // Changing the birth month in Personal details asks for the day again (and stops sharing until then).
  await m.post('/profile', t.profile({ first_name: 'Nila', birth_year: '1985', birth_month: String((tm % 12) + 1) }));
  assert.deepEqual({ ...db.prepare('SELECT birthday, share_birthday FROM users WHERE id = ?').get(uid) }, { birthday: null, share_birthday: 0 });

  // A child's birthday stays in their locked birth month, whatever month is sent.
  await m.post('/profile/household', { name: 'Om Member', relationship: 'Son', birth_month: '3', birth_year: '2015' });
  const om = db.prepare(`SELECT id FROM household_members WHERE name = 'Om Member'`).get().id;
  await m.post('/profile/celebrations', { [`birthday_month_${om}`]: '9', [`birthday_day_${om}`]: '14', [`share_birthday_${om}`]: '1' });
  assert.equal(db.prepare('SELECT birthday FROM household_members WHERE id = ?').get(om).birthday, '03-14');
  // On the profile, Om's month and year are shown locked; only the day can be picked (March has 31).
  const omRow = (await m.get('/profile')).text.split(`name="birthday_month_${om}"`)[1].split('</fieldset>')[0];
  assert.match(omRow, /^ value="3">\s*<span class="locked-field"[^>]*>Mar 2015 🔒<\/span>/);
  assert.match(omRow, /<option value="31" *>31<\/option>/);
  assert.match(omRow, /<option value="14" selected>14<\/option>/);
  // No February 29 for a child born in a common year.
  await m.post('/profile/household', { name: 'Leela Member', relationship: 'Daughter', birth_month: '2', birth_year: '2015' });
  const leela = db.prepare(`SELECT id FROM household_members WHERE name = 'Leela Member'`).get().id;
  await m.post('/profile/celebrations', { [`birthday_day_${leela}`]: '29', [`share_birthday_${leela}`]: '1' });
  assert.deepEqual({ ...db.prepare('SELECT birthday, share_birthday FROM household_members WHERE id = ?').get(leela) }, { birthday: null, share_birthday: 0 });
});

test('announcements show only their date to members; only the committee sees who posted', async () => {
  await admin.post('/admin/news', { title: 'Diwali volunteers needed', body: 'Please sign up at the desk.' });
  const m = await t.register('announce@test.org', 'Reader');
  const res = await m.get('/news');
  assert.match(res.text, /Diwali volunteers needed<\/h2>\s*(<%[^>]*>\s*)?<p class="muted small"[^>]*>[^<·]+<\/p>/);
  assert.doesNotMatch(res.text, /Admin User|GSA Committee/);
  assert.match((await admin.get('/admin/news')).text, /Diwali volunteers needed[\s\S]*?posted by Admin User/);
});

test('a source in both languages: each story goes to readers of its own language', async () => {
  const { db } = t;
  const MIXED = `<rss><channel>
    <item><title>Surat diamond market sparkles before Diwali</title><link>https://mixed.example.com/en</link><guid>m-en</guid></item>
    <item><title>અમદાવાદમાં દિવાળીની તૈયારીઓ</title><link>https://mixed.example.com/gu</link><guid>m-gu</guid></item>
  </channel></rss>`;
  const realFetch = global.fetch;
  global.fetch = (url, opts) => (String(url).startsWith('https://mixed.example.com') ? fakeFetch({ 'https://mixed.example.com/rss': MIXED })(url) : realFetch(url, opts));
  try {
    const res = await admin.follow(await admin.post('/admin/news/feeds', { name: 'Mixed paper', url: 'https://mixed.example.com/rss', lang: 'both', topic: 'Food & recipes' }));
    assert.match(res.text, /Mixed paper: working, 2 headlines found/);
    assert.match(res.text, /Gujarati &amp; English · Food &amp; recipes/);
  } finally {
    global.fetch = realFetch;
  }
  const titles = (lang) => newsfeed.visibleNews(db, { lang, topic: 'Food & recipes' }).items.map((i) => i.title);
  assert.deepEqual(titles('en'), ['Surat diamond market sparkles before Diwali']);
  assert.deepEqual(titles('gu'), ['અમદાવાદમાં દિવાળીની તૈયારીઓ']);
  assert.equal(titles('').length, 2);
  const m = await t.register('foodie@test.org', 'Foodie');
  const page = await m.get('/news/india?lang=all&topic=Food+%26+recipes');
  assert.match(page.text, /<h2 lang="gu">અમદાવાદમાં દિવાળીની તૈયારીઓ<\/h2>/);
  assert.match(page.text, /<h2 lang="en">Surat diamond market/);
  assert.match(page.text, /class="active">Food &amp; recipes</);
});

test('home tiles: membership status, level and renewal; a yellow Pay dues tile when not active; no duplicate boxes', async () => {
  const m = await t.register('tiles@test.org', 'Tile', 1); // gets a Family membership for this year
  let res = await m.get('/dashboard');
  assert.match(res.text, /class="tile" href="\/membership"[\s\S]*?Membership <span class="badge ok">Active<\/span>[\s\S]*?<strong>Family<\/strong><br>Active until Dec 31, \d{4}/);
  assert.match(res.text, new RegExp(`Renew for ${Number(require('../src/util').today().slice(0, 4)) + 1}`));
  assert.match(res.text, /My profile &amp; family<\/span><small>Contact details, family members/);
  assert.doesNotMatch(res.text, /Renew or view history|Edit profile|Keep your contact information/);

  const n = await t.register('unpaid@test.org', 'Unpaid');
  res = await n.get('/dashboard');
  assert.match(res.text, /class="tile warn" href="\/membership"[\s\S]*?Pay dues <span class="badge warn">Not active<\/span>[\s\S]*?Not a paid member yet/);
});

test('home: a "Today" banner with the QR ticket on event day; Donate tile; no duplicate shortcut tiles', async () => {
  const today = require('../src/util').today();
  const eventId = await t.createEvent(admin, { title: 'Sharad Purnima Garba', starts_at: `${today}T23:30`, location: 'GSA Community Center | 1 GSA Circle, Little Rock, AR 72209' });
  const m = await t.register('today@test.org', 'Today', 1);
  await m.post(`/events/${eventId}/rsvp`, { party_size: '1' });
  const rsvp = t.rsvpFor(eventId, 'today@test.org');
  const res = await m.get('/dashboard');
  // On event day the "Your next event" tile turns green and says Today, with the QR ticket button.
  assert.match(res.text, new RegExp(`class="card next-event today"[\\s\\S]*?Today · 11:30 PM[\\s\\S]*?Sharad Purnima Garba[\\s\\S]*?GSA Community Center[\\s\\S]*?href="/tickets/${rsvp.id}"`));
  assert.doesNotMatch(res.text, /today-banner|My upcoming events|My QR tickets/, 'no separate banner, events box or tickets tile');
  // Short event lines: weekday, time and venue name, not the full street address.
  assert.doesNotMatch(res.text.slice(res.text.indexOf('next-event'), res.text.indexOf('</main>')), /1 GSA Circle/);
  assert.match(res.text, /class="tile" href="\/donate"/);
  assert.doesNotMatch(res.text, /Events &amp; RSVP|href="\/directory"><svg[^]*?Find community members/);
  assert.match(res.text, /data-compact-menu hidden/);
});

test('home headlines take turns between sources instead of five from one paper', () => {
  const { db } = t;
  const add = (name) => Number(db.prepare(`INSERT INTO news_sources (name, url, lang, topic) VALUES (?, ?, 'en', 'India')`).run(name, `https://${name}.example.com/rss`).lastInsertRowid);
  const wasOn = db.prepare('SELECT id FROM news_sources WHERE enabled = 1').all().map((r) => r.id);
  db.prepare('UPDATE news_sources SET enabled = 0').run();
  const busy = add('busy'); const quiet = add('quiet'); const third = add('third');
  const story = db.prepare("INSERT INTO news_items (source_id, guid, title, link, published_at) VALUES (?, ?, ?, 'https://x.example.com', datetime('now', ?))");
  for (let i = 1; i <= 6; i++) story.run(busy, `b${i}`, `Busy story ${i}`, `-${i} minutes`);
  story.run(quiet, 'q1', 'Quiet story 1', '-2 hours');
  story.run(third, 't1', 'Third story 1', '-3 hours');
  story.run(third, 't2', 'Third story 2', '-4 hours');
  assert.deepEqual(newsfeed.mixedHeadlines(db, { limit: 5 }).map((h) => h.title),
    ['Busy story 1', 'Quiet story 1', 'Third story 1', 'Busy story 2', 'Third story 2']);
  db.prepare('DELETE FROM news_sources WHERE id IN (?, ?, ?)').run(busy, quiet, third);
  for (const id of wasOn) db.prepare('UPDATE news_sources SET enabled = 1 WHERE id = ?').run(id);
});

test('display settings sit at the bottom of Profile only; Profile has no second Sign out', async () => {
  const m = await t.register('settings@test.org', 'Settings');
  const profile = (await m.get('/profile')).text;
  const main = profile.slice(profile.indexOf('<main'), profile.indexOf('</main>'));
  assert.ok(main.indexOf('id="display"') > main.indexOf('Change password'), 'after Change password');
  assert.doesNotMatch(main, /action="\/logout"/, 'Sign out only in the header');
  const more = (await m.get('/more')).text;
  assert.doesNotMatch(more, /id="display"/, 'not repeated on More (the header buttons cover everyday switching)');
});

test('donate: a General fund box, and "Give to this fund" picks the fund in the form', async () => {
  const id = Number(t.db.prepare(`INSERT INTO campaigns (title, description, goal_cents, active) VALUES ('Baby fund', 'For future babies', 1000000, 1)`).run().lastInsertRowid);
  const m = await t.register('giver@test.org', 'Giver');
  let res = await m.get('/donate');
  assert.match(res.text, /<h2>General fund<\/h2>\s*<p class="muted">Where GSA needs it most/);
  assert.match(res.text, /raised this year/);
  assert.match(res.text, new RegExp(`href="/donate\\?campaign=${id}#give"`));
  assert.match(res.text, /href="\/donate\?campaign=general#give"/);
  res = await m.get(`/donate?campaign=${id}`);
  assert.match(res.text, new RegExp(`<option value="${id}" selected>Baby fund</option>`));
  assert.match(res.text, /class="card fund-card chosen">\s*<h2>Baby fund/);
  res = await m.get('/donate?campaign=general');
  assert.match(res.text, /class="card fund-card chosen">\s*<h2>General fund/);
  assert.doesNotMatch(res.text, /<option value="\d+" selected>/);
});

test('donate: a typed "Other amount" is what gets charged, and Cancel returns to the Donate page', async () => {
  const m = await t.register('typed@test.org', 'Typed');
  await m.get('/donate');
  // $51 still selected, but the member typed 75: the typed amount wins.
  let res = await m.post('/donate', { campaign_id: '', amount: '5100', other_amount: '75', note: '' });
  const payment = t.db.prepare(`SELECT p.* FROM payments p JOIN users u ON u.id = p.user_id WHERE u.email = 'typed@test.org' ORDER BY p.id DESC LIMIT 1`).get();
  assert.equal(payment.amount_cents, 7500);
  res = await m.get(`/pay/${payment.id}/cancelled`);
  assert.equal(res.location, '/donate?campaign=general#give');
  // A preset with the box left empty still works.
  await m.post('/donate', { campaign_id: '', amount: '10100', other_amount: '', note: '' });
  assert.equal(t.db.prepare(`SELECT amount_cents FROM payments p JOIN users u ON u.id = p.user_id WHERE u.email = 'typed@test.org' ORDER BY p.id DESC LIMIT 1`).get().amount_cents, 10100);
});

test('main menu order: Home, Events, My tickets, Membership, Donate / Profile, Photos, News, Directory, About GSA', async () => {
  const m = await t.register('menu@test.org', 'Menu');
  const html = (await m.get('/dashboard')).text;
  const menu = html.slice(html.indexOf('class="menu-band member-menu'), html.indexOf('</nav>', html.indexOf('class="menu-band member-menu')));
  assert.deepEqual([...menu.matchAll(/<span>([^<]+)<\/span><\/a>/g)].map((x) => x[1]),
    ['Home', 'Events', 'My tickets', 'Membership', 'Donate', 'Profile', 'Photos', 'News', 'Directory', 'About GSA']);
});
