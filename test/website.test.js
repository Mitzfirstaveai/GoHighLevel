const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');

let t;
before(async () => { t = await startTestApp(); });
after(() => t.close());

test('visitors see the website: logo, sign-in form, the GSA app and the menu', async () => {
  const c = new t.Client();
  const res = await c.get('/');
  assert.equal(res.status, 200);
  assert.match(res.text, /<main id="main" class="site">/);
  assert.match(res.text, /<h1 class="hero-title">Welcome to Test Samaj<\/h1>/);
  assert.match(res.text, /<img class="hero-logo" src="\/logo\.png" alt="Test Samaj logo"/);
  // Sign in right on the page…
  assert.match(res.text, /<form method="post" action="\/login" class="stack">\s*<input type="hidden" name="_csrf" value="[^"]+">/);
  assert.match(res.text, /name="password" required autocomplete="current-password"/);
  // …or open the app, with install steps and a QR code for computers.
  assert.match(res.text, /<a class="btn btn-light big" href="\/dashboard">/);
  assert.match(res.text, /data-site-install/);
  assert.match(res.text, /<div class="qr-box"><svg [^>]*viewBox/);
  for (const href of ['/#events', '/#app', '/#membership', '/about', '/committee', '/sponsors', '/contact']) {
    assert.match(res.text, new RegExp(`<nav class="nav mainnav visitor-nav"[\\s\\S]*href="${href}"`), href);
  }
});

test('the website shows the next events and membership levels from the app', async () => {
  const admin = await t.login('admin@test.org', 'adminpass1');
  const upcoming = await t.createEvent(admin, { title: 'Sharad Purnima Garba', starts_at: t.futureDate(5, '19:30'), location: 'GSA Community Center', fee: '12' });
  await t.createEvent(admin, { title: 'Members Only AGM', starts_at: t.futureDate(6), members_only: '1' });
  await t.createEvent(admin, { title: 'Draft Planning Meeting', status: 'draft', starts_at: t.futureDate(4) });
  await t.createEvent(admin, { title: 'Last Year Picnic', starts_at: t.futureDate(-30) });

  const res = await new t.Client().get('/');
  assert.match(res.text, new RegExp(`href="/events/${upcoming}"[\\s\\S]*Sharad Purnima Garba[\\s\\S]*GSA Community Center[\\s\\S]*Members \\$12\\.00/person`));
  assert.match(res.text, /Members Only AGM[\s\S]*?<\/a>/);
  assert.match(res.text, /<span class="ev-badge">Members only<\/span>/);
  assert.doesNotMatch(res.text, /Draft Planning Meeting/);
  assert.doesNotMatch(res.text, /Last Year Picnic/);
  // Levels and prices, in price order, each with who it covers.
  assert.match(res.text, /Senior Citizen<\/h3>\s*<p class="plan-price">\$110\.00[\s\S]*Family with Parents<\/h3>\s*<p class="plan-price">\$385\.00/);
  assert.match(res.text, /Covers <strong>you, your spouse, your unmarried children and one set of parents<\/strong>/);

  // An event card asks the visitor to sign in, then brings them back to that event.
  const c = new t.Client();
  assert.equal((await c.get(`/events/${upcoming}`)).location, '/login');
  await t.register('website-visitor@test.org');
  const res2 = await c.post('/login', { email: 'website-visitor@test.org', password: 'secret123' });
  assert.equal(res2.location, `/events/${upcoming}`);
});

test('signing in on the website opens the member app', async () => {
  await t.register('web-signin@test.org');
  const c = new t.Client();
  await c.get('/');
  const res = await c.post('/login', { email: 'web-signin@test.org', password: 'secret123' });
  assert.equal(res.status, 302);
  const home = await c.follow(res);
  assert.match(home.text, /Namaste, Test/);
  // Signed in, the website address goes straight to the app.
  assert.equal((await c.get('/')).location, '/dashboard');
  const admin = await t.login('admin@test.org', 'adminpass1');
  assert.equal((await admin.get('/')).location, '/admin');
});

test('"Open the GSA app" asks a visitor to sign in, then opens the app', async () => {
  await t.register('open-app@test.org');
  const c = new t.Client();
  assert.equal((await c.get('/dashboard')).location, '/login');
  const res = await c.post('/login', { email: 'open-app@test.org', password: 'secret123' });
  assert.equal(res.location, '/dashboard');
});

test('the website still works with no events or levels set up yet', async () => {
  const empty = await startTestApp();
  try {
    empty.db.exec('DELETE FROM membership_plans');
    const res = await new empty.Client().get('/');
    assert.equal(res.status, 200);
    assert.match(res.text, /New events are announced here soon/);
    assert.doesNotMatch(res.text, /class="plan-grid"/);
  } finally {
    empty.close();
  }
});
