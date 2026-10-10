// What every member has to fill in: name, email, phone, birth month and year, native place and address,
// and a birth month and year for everyone on their family list.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');

let t;
let admin;

before(async () => {
  t = await startTestApp();
  admin = await t.adminLogin();
});
after(() => t.close());

const userId = (email) => t.db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;

test('signing up needs phone, birth month and year, native place and full address', async () => {
  const c = new t.Client();
  let res = await c.get('/register');
  for (const name of ['first_name', 'last_name', 'email', 'phone', 'birth_month', 'birth_year', 'native_place', 'address_line1', 'city', 'state', 'postal_code']) {
    assert.match(res.text, new RegExp(`name="${name}"[^>]*required`), name);
  }
  assert.doesNotMatch(res.text, /name="address_line2"[^>]*required/, 'apartment is optional');
  assert.doesNotMatch(res.text, /type="date"/, 'only the month and year of birth are asked for');

  const signUp = (fields) => c.post('/register', t.profile({ email: 'newbie@test.org', password: 'Chai#Masala2026', password_confirm: 'Chai#Masala2026', ...fields }));
  res = await signUp({ phone: '', native_place: '', postal_code: '' });
  assert.equal(res.status, 400);
  assert.match(res.text, /Please fill in: Phone, Native place \(Vatan\) and ZIP code\./);
  assert.match(res.text, /name="city" value="Little Rock"/, 'what they typed is kept');
  assert.match((await signUp({ birth_year: '85' })).text, /Please choose the birth month and enter a 4-digit birth year/);
  assert.match((await signUp({ birth_year: String(new Date().getFullYear() + 1) })).text, /4-digit birth year/);
  assert.match((await signUp({ phone: '555-1234' })).text, /phone number with area code/);
  assert.match((await signUp({ postal_code: '7220' })).text, /5-digit ZIP code/);
  assert.equal(t.db.prepare(`SELECT COUNT(*) AS n FROM users WHERE email = 'newbie@test.org'`).get().n, 0);

  res = await signUp({ birth_month: '10', birth_year: '1984', native_place: 'Nadiad', address_line2: 'Apt 4' });
  assert.equal(res.location, '/profile');
  const u = t.db.prepare(`SELECT phone, birth_month, birth_year, birthday, native_place, address_line1, address_line2, city, state, postal_code
    FROM users WHERE email = 'newbie@test.org'`).get();
  assert.deepEqual({ ...u }, { phone: '501-555-0199', birth_month: 10, birth_year: 1984, birthday: null, native_place: 'Nadiad',
    address_line1: '1 Test St', address_line2: 'Apt 4', city: 'Little Rock', state: 'AR', postal_code: '72201' });

  // The profile can't be saved with a required field emptied.
  await c.get('/profile'); // CSRF token for the new session
  res = await c.follow(await c.post('/profile', t.profile({ address_line1: '' })));
  assert.match(res.text, /Please fill in: Address/);
  assert.equal(t.db.prepare(`SELECT address_line1 FROM users WHERE email = 'newbie@test.org'`).get().address_line1, '1 Test St');
});

test('everyone on the family list needs a birth month and year', async () => {
  const m = await t.register('famreq@test.org', 'Fam');
  let res = await m.follow(await m.post('/profile/household', { name: 'Papa Req', relationship: 'Father' }));
  assert.match(res.text, /Please enter the birth month and year for Papa Req/);
  await m.post('/profile/household', { name: 'Papa Req', relationship: 'Father', birth_month: '1', birth_year: '1950' });
  assert.deepEqual({ ...t.db.prepare(`SELECT birth_month, birth_year FROM household_members WHERE name = 'Papa Req'`).get() }, { birth_month: 1, birth_year: 1950 });
  // The committee can still add someone without one (e.g. from old records); the member is then asked once.
  await admin.post(`/admin/members/${userId('famreq@test.org')}/household`, { name: 'Ba Req', relationship: 'Mother' });
  const ba = t.db.prepare(`SELECT id FROM household_members WHERE name = 'Ba Req'`).get().id;
  res = await m.get('/profile');
  assert.match(res.text, new RegExp(`action="/profile/household/${ba}/birth"[\\s\\S]*Add Ba Req&#39;s birth month and year \\(required for everyone on the family list\\)`));
  res = await m.get('/dashboard');
  assert.match(res.text, /Please complete your profile[\s\S]*Birth month and year for Ba Req \(Family members\)/);
  // Membership can't be paid until it's filled in.
  res = await m.follow(await m.post('/membership/pay', { plan_id: String(t.planId('Family with Parents')) }));
  assert.match(res.text, /Please add the birth month and year for Ba Req under Family members first/);
  await m.post(`/profile/household/${ba}/birth`, { birth_month: '7', birth_year: '1953' });
  assert.doesNotMatch((await m.get('/dashboard')).text, /Please complete your profile/);
  res = await m.post('/membership/pay', { plan_id: String(t.planId('Family with Parents')) });
  assert.match(res.location, /^\/pay\/\d+\/demo$/);
});

test('members added by the committee or imported are asked to complete their profile before paying dues', async () => {
  // An imported member with a login but only a name, email and city.
  await admin.post('/admin/members/new', { first_name: 'Old', last_name: 'Record', email: 'oldrecord@test.org', city: 'Conway', create_login: '1' });
  t.db.prepare(`UPDATE users SET password_hash = (SELECT password_hash FROM users WHERE email = 'famreq@test.org'), password_temporary = 0 WHERE email = 'oldrecord@test.org'`).run(); // (as if they'd chosen their own)
  const m = await t.login('oldrecord@test.org', 'Chai#Masala2026');
  let res = await m.get('/dashboard');
  assert.match(res.text, /Please complete your profile[\s\S]*Still needed: Phone, Birth month, Birth year, Native place \(Vatan\), Address, State and ZIP code\.[\s\S]*href="\/profile"/);
  res = await m.follow(await m.post('/membership/pay', { plan_id: String(t.planId('Individual')) }));
  assert.match(res.text, /Please complete your profile first: Phone, Birth month/);
  // Events still work while they finish it.
  const ev = await t.createEvent(admin, { title: 'Open Garba' });
  res = await m.post(`/events/${ev}/rsvp`, { party_size: '1' });
  assert.match(res.location, /^\/tickets\/\d+$/);
  await m.post('/profile', t.profile({ first_name: 'Old', last_name: 'Record' }));
  assert.doesNotMatch((await m.get('/dashboard')).text, /Please complete your profile/);
});

test("a family login starts with the family's address, native place and the birth month and year on the list", async () => {
  const m = await t.register('owner@test.org', 'Owner');
  await m.post('/profile', t.profile({ first_name: 'Owner', native_place: 'Navsari', address_line1: '9 Family Rd', city: 'Benton', postal_code: '72015' }));
  await m.post('/profile/household', { name: 'Sita Member', relationship: 'Spouse', birth_month: '11', birth_year: '1987' });
  const row = t.db.prepare(`SELECT id FROM household_members WHERE name = 'Sita Member'`).get().id;
  await m.post(`/profile/household/${row}/invite`, {});
  const token = t.db.prepare('SELECT invite_token FROM household_members WHERE id = ?').get(row).invite_token;
  const s = new t.Client();
  let res = await s.get(`/join/family/${token}`);
  assert.match(res.text, /name="address_line1" value="9 Family Rd"/);
  assert.match(res.text, /name="native_place" value="Navsari"/);
  assert.match(res.text, /<option value="11" selected>November<\/option>/);
  assert.match(res.text, /name="birth_year"[^>]*value="1987"/);
  assert.match(res.text, /name="phone" value=""[^>]*required/);
  res = await s.post(`/join/family/${token}`, { email: 'sita@test.org', password: 'Chai#Masala2026', password_confirm: 'Chai#Masala2026', first_name: 'Sita', last_name: 'Member', phone: '501-555-0177' });
  assert.equal(res.location, '/dashboard');
  const u = t.db.prepare(`SELECT birth_month, birth_year, native_place, city, postal_code FROM users WHERE email = 'sita@test.org'`).get();
  assert.deepEqual({ ...u }, { birth_month: 11, birth_year: 1987, native_place: 'Navsari', city: 'Benton', postal_code: '72015' });
  assert.doesNotMatch((await s.get('/dashboard')).text, /Please complete your profile/);
});

test('names, places and cities are letters only; phone, ZIP and year are numbers only; state from the list', async () => {
  const m = await t.register('rules@test.org', 'Rule');
  const save = async (fields) => (await m.follow(await m.post('/profile', t.profile({ first_name: 'Rule', ...fields })))).text;
  const saved = () => ({ ...t.db.prepare(`SELECT first_name, last_name, phone, city, state, postal_code, native_place, address_line1
    FROM users WHERE email = 'rules@test.org'`).get() });
  const before = saved();
  const refused = [
    [{ last_name: '1234' }, /Last name can only contain letters/],
    [{ first_name: 'Pr1ya' }, /First name can only contain letters/],
    [{ first_name: '<script>' }, /First name can only contain letters/],
    [{ native_place: '42' }, /Native place can only contain letters/],
    [{ city: 'Conway 2' }, /City can only contain letters/],
    [{ occupation: '12345' }, /Occupation can only contain letters/],
    [{ address_line1: 'Main Street' }, /street address with a number and street name/],
    [{ address_line1: '12345' }, /street address with a number and street name/],
    [{ phone: 'call me' }, /10-digit phone number/],
    [{ phone: '501-555-01' }, /10-digit phone number/],
    [{ postal_code: '72A01' }, /5-digit ZIP code \(numbers only\)/],
    [{ state: 'Narnia' }, /Please choose a state/],
    [{ birth_year: '19x5' }, /4-digit birth year/],
  ];
  for (const [fields, message] of refused) {
    assert.match(await save(fields), message, JSON.stringify(fields));
    assert.deepEqual(saved(), before, `nothing saved for ${JSON.stringify(fields)}`);
  }
  // Real names and addresses (accents, hyphens, apostrophes, Gujarati) are fine; phone and state are tidied up.
  assert.match(await save({ first_name: "Ma'ya-Rani", last_name: 'પટેલ', phone: '(501) 555 0123', state: 'arkansas',
    native_place: 'Vadodara (Baroda)', city: 'North Little Rock', address_line1: '137 Main St, #4', postal_code: '72201-1234', occupation: 'Doctor & Teacher' }), /Profile saved/);
  assert.deepEqual(saved(), { first_name: "Ma'ya-Rani", last_name: 'પટેલ', phone: '501-555-0123', city: 'North Little Rock', state: 'AR',
    postal_code: '72201-1234', native_place: 'Vadodara (Baroda)', address_line1: '137 Main St, #4' });
  // Family members' names too.
  const res = await m.follow(await m.post('/profile/household', { name: 'Kid 2', relationship: 'Son', birth_month: '1', birth_year: '2015' }));
  assert.match(res.text, /family member&#39;s name can only contain letters/);
  // The form carries the same rules, so the browser stops a wrong entry before sending it.
  const form = (await m.get('/profile')).text;
  assert.match(form, /name="last_name"[^>]*pattern="\[\\p\{L\}\\p\{M\}\]/);
  assert.match(form, /name="postal_code"[^>]*pattern="\\d\{5\}\(-\\d\{4\}\)\?"/);
  assert.match(form, /<select name="state"[^>]*required>[\s\S]*<option value="AR" selected>Arkansas<\/option>/);
});
