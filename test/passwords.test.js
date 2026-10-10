// Strong passwords: 8+ characters, mixed (upper, lower, number, symbol), not common, not the person's own name
// or email — for members, the committee and door volunteers alike. Stored only as a bcrypt hash.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const { startTestApp } = require('./helpers');
const { passwordProblem, temporaryPassword } = require('../src/passwords');

let t;
let admin;
before(async () => { t = await startTestApp(); admin = await t.adminLogin(); });
after(() => t.close());

const problem = (pw, user) => passwordProblem(pw, user)?.message || null;

test('the rules: length, a mix of characters, not common, not your own name or email', () => {
  const priya = { email: 'priya.shah@example.org', first_name: 'Priya', last_name: 'Shah', role: 'member' };
  assert.equal(problem('Chai#Masala2026', priya), null);
  assert.equal(problem('Mango!Tree7Rain', priya), null);
  assert.match(problem('Lo#4927', priya), /at least \{n\} characters/);
  assert.equal(passwordProblem('Lotus#49', priya), null, '8 is enough');
  assert.match(problem('chai#masala2026', priya), /uppercase letter, a lowercase letter, a number and a symbol/);
  assert.match(problem('ChaiMasala2026', priya), /a symbol/);
  assert.match(problem('Chai#Masala#Rain', priya), /a number/);
  for (const common of ['Password#2026', 'Garba@2026!!', 'Gujarat#20265', 'Qwerty!12345', 'Navratri#1999', 'Xy#1234567ab', 'Aaaa#bbbb99Z'])
    assert.match(problem(common, priya), /too common or easy to guess/, common);
  assert.match(problem('Priya#Garden2026', priya), /your name or email/);
  assert.match(problem('Shah!Garden2026', priya), /your name or email/);
  assert.match(problem('x'.repeat(60) + 'Ab#1Zq', priya), /too long/);
  // The same for the committee and door volunteers.
  assert.equal(passwordProblem('Lotus#49', { ...priya, role: 'admin' }), null);
  assert.match(problem('Lo#4927', { ...priya, checkin_access: 1 }), /at least/);
  // Temporary passwords handed out by the committee meet every rule.
  for (let i = 0; i < 50; i++) assert.equal(problem(temporaryPassword(), { role: 'admin' }), null);
});

test('sign-up, family invites and the profile refuse weak passwords, in the member’s language; the form lists the rules', async () => {
  const c = new t.Client();
  let res = await c.get('/register');
  assert.match(res.text, /data-password-rules[\s\S]*data-pw-toggle[\s\S]*At least 8 characters[\s\S]*An uppercase letter[\s\S]*A symbol, like ! # \$ @/);
  res = await c.post('/register', t.profile({ email: 'weak@test.org', password: 'Ga#2026', password_confirm: 'Ga#2026' }));
  assert.equal(res.status, 400);
  assert.match(res.text, /Password must be at least 8 characters\./);
  res = await c.post('/register', t.profile({ email: 'weak@test.org', password: 'Garba@20261', password_confirm: 'Garba@20261' }));
  assert.match(res.text, /too common or easy to guess/);
  assert.ok(!t.db.prepare(`SELECT 1 FROM users WHERE email = 'weak@test.org'`).get());
  await c.get('/prefs?lang=gu&back=/register');
  res = await c.post('/register', t.profile({ email: 'weak@test.org', password: 'chai#masala2026', password_confirm: 'chai#masala2026' }));
  assert.match(res.text, /પાસવર્ડમાં એક મોટો અક્ષર/);

  const m = await t.register('changer@test.org', 'Changer');
  res = await m.follow(await m.post('/profile/password', { current_password: 'Chai#Masala2026', new_password: 'shrt1!A', new_password_confirm: 'shrt1!A' }));
  assert.match(res.text, /at least 8 characters/);
  res = await m.follow(await m.post('/profile/password', { current_password: 'Chai#Masala2026', new_password: 'Changer#Lake2026', new_password_confirm: 'Changer#Lake2026' }));
  assert.match(res.text, /your name or email/);
  res = await m.follow(await m.post('/profile/password', { current_password: 'Chai#Masala2026', new_password: 'Mango!Tree7Rain', new_password_confirm: 'Mango!Tree7Rain' }));
  assert.match(res.text, /Password changed\./);
});

test('passwords are stored only as a slow, salted hash — never as text', async () => {
  await t.register('hashme@test.org', 'Hash');
  const { password_hash: hash } = t.db.prepare(`SELECT password_hash FROM users WHERE email = 'hashme@test.org'`).get();
  assert.doesNotMatch(hash, /Masala/);
  assert.match(hash, /^\$2[aby]\$12\$/, 'bcrypt, work factor 12');
  assert.ok(bcrypt.compareSync('Chai#Masala2026', hash));
  // An older, quicker hash is upgraded when they next sign in.
  t.db.prepare(`UPDATE users SET password_hash = ? WHERE email = 'hashme@test.org'`).run(bcrypt.hashSync('Chai#Masala2026', 10));
  await t.login('hashme@test.org', 'Chai#Masala2026');
  assert.match(t.db.prepare(`SELECT password_hash FROM users WHERE email = 'hashme@test.org'`).get().password_hash, /^\$2[aby]\$12\$/);
});

test('a weak older password, or a temporary one from the committee, must be replaced before anything else', async () => {
  // A member whose password predates the rules.
  await t.register('older@test.org', 'Older');
  t.db.prepare(`UPDATE users SET password_hash = ? WHERE email = 'older@test.org'`).run(bcrypt.hashSync('garba123', 12));
  const c = new t.Client();
  await c.get('/login');
  let res = await c.post('/login', { email: 'older@test.org', password: 'garba123' });
  assert.equal(res.location, '/password/new');
  res = await c.get('/dashboard');
  assert.equal(res.location, '/password/new', 'every page leads to the new-password page');
  res = await c.get('/password/new');
  assert.match(res.text, /GSA now asks for stronger passwords[\s\S]*At least 8 characters/);
  res = await c.post('/password/new', { password: 'Weakish12', password_confirm: 'Weakish12' });
  assert.equal(res.status, 400);
  res = await c.post('/password/new', { password: 'Mango!Tree7Rain', password_confirm: 'Mango!Tree7Rain' });
  assert.equal(res.location, '/dashboard');
  assert.equal((await c.get('/dashboard')).status, 200);
  await t.login('older@test.org', 'Mango!Tree7Rain');

  // A password reset by the committee is strong, and must be replaced at first sign-in (not with itself).
  const ramesh = await t.register('ramesh2@test.org', 'Ramesh');
  void ramesh;
  const id = t.db.prepare(`SELECT id FROM users WHERE email = 'ramesh2@test.org'`).get().id;
  res = await admin.follow(await admin.post(`/admin/members/${id}/reset-password`));
  const temp = res.text.match(/Temporary password: (\S+)/)[1];
  assert.equal(passwordProblem(temp, { role: 'admin' }), null);
  assert.match(res.text, /choose their own password when they first sign in/);
  const r = new t.Client();
  await r.get('/login');
  res = await r.post('/login', { email: 'ramesh2@test.org', password: temp });
  assert.equal(res.location, '/password/new');
  assert.match((await r.get('/password/new')).text, /temporary password from a committee member/);
  res = await r.post('/password/new', { password: temp, password_confirm: temp });
  assert.match(res.text, /different from the one you signed in with/);
  res = await r.post('/password/new', { password: 'River#Lotus2026', password_confirm: 'River#Lotus2026' });
  assert.equal(res.location, '/dashboard');
  assert.equal(t.db.prepare('SELECT password_temporary FROM users WHERE id = ?').get(id).password_temporary, 0);
});
