// The shared door login: username "door" and a short password the committee sets and gives to everyone helping
// at the door. It opens only door check-in (no money: families who owe go to a committee member); each volunteer
// types their first name, kept with every check-in. Changing the password or turning it off signs out every phone.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startTestApp } = require('./helpers');
const { nowLocal } = require('../src/util');

let t;
let admin;
let event;

before(async () => {
  t = await startTestApp();
  admin = await t.adminLogin();
  event = await t.createEvent(admin, { title: 'Garba Tonight', fee: '5', starts_at: `${nowLocal().slice(0, 10)}T23:59` });
});
after(() => t.close());

async function doorSignIn(username, password) {
  const c = new t.Client();
  await c.get('/admin/login');
  const res = await c.post('/admin/login', { email: username, password });
  return { c, res };
}

test('the committee turns it on with a short, simple password; it never appears among members', async () => {
  let res = await admin.get('/admin/checkin');
  assert.match(res.text, /Shared door login[\s\S]*Off[\s\S]*data-suggest-password[\s\S]*Turn on with this password/);
  res = await admin.follow(await admin.post('/admin/door-login', { password: 'abc' }));
  assert.match(res.text, /The door password must be at least 4 characters/);
  res = await admin.follow(await admin.post('/admin/door-login', { password: 'garba25' }));
  assert.match(res.text, /Shared door login is on\. Username: door/);
  assert.match(res.text, /Shared door login[\s\S]*On[\s\S]*username <code[^>]*>door<\/code>[\s\S]*Change password[\s\S]*Turn off the door login/);
  // Not a member or a contact, and not in the list of volunteers with their own login.
  assert.doesNotMatch((await admin.get('/admin/members?q=door')).text, /Door volunteers/);
  assert.doesNotMatch(res.text.split('Door volunteers with their own login')[1], /Door volunteers/);
});

test('volunteers sign in with "door", type their first name, see only check-in, and send anyone who owes to the committee', async () => {
  const m = await t.register('tonight@test.org', 'Tara');
  await m.post(`/events/${event}/rsvp`, { party_size: '1', pay: 'door' });
  const rsvp = t.rsvpFor(event, 'tonight@test.org');

  const { c: door, res } = await doorSignIn('Door', 'garba25'); // any capitalisation of the username
  assert.equal(res.location, '/admin/checkin/name');
  assert.equal((await door.get('/admin/checkin')).location, '/admin/checkin/name', 'name first');
  assert.equal((await door.get('/admin')).location, '/admin/checkin', 'no admin pages');
  assert.equal((await door.get('/dashboard')).location, '/admin/checkin', 'no member pages');
  let page = await door.get('/admin/checkin/name');
  assert.match(page.text, /Who is helping at the door\?/);
  assert.equal((await door.post('/admin/checkin/name', { name: '1234' })).status, 400);
  assert.equal((await door.post('/admin/checkin/name', { name: ' Mitesh ' })).location, '/admin/checkin');
  page = await door.get('/admin/checkin');
  assert.match(page.text, /Helping at the door: Mitesh[\s\S]*Not you\?/);
  assert.doesNotMatch(page.text, /Shared door login/, 'the settings are for the committee');

  // $5 owed in cash: one tap marks it paid and checks them in; both carry Mitesh's name. (Venmo etc. are refused.)
  let r = await door.get(`/admin/checkin/${rsvp.qr_token}`);
  assert.match(r.text, /\$5\.00 DUE[\s\S]*value="cash"[\s\S]*id="pay-online"/);
  r = await door.follow(await door.post(`/admin/checkin/${rsvp.qr_token}/payment`, { method: 'venmo', checkin: '1', guests: '1' }));
  assert.match(r.text, /Door volunteers record cash only/);
  r = await door.follow(await door.post(`/admin/checkin/${rsvp.qr_token}/payment`, { method: 'cash', checkin: '1', guests: '1' }));
  assert.match(r.text, /Recorded \$5\.00 paid by cash and checked in Tara Member[\s\S]*by Mitesh/);
  assert.equal(t.db.prepare('SELECT checked_in_name FROM rsvps WHERE id = ?').get(rsvp.id).checked_in_name, 'Mitesh');
  assert.equal(t.db.prepare(`SELECT recorded_name FROM payments WHERE reference_id = ? AND status = 'paid'`).get(rsvp.id).recorded_name, 'Mitesh');

  // Someone else takes over the phone: "Not you?" asks for the new name.
  await door.post('/admin/checkin/name', { name: 'Hetal' });
  assert.match((await door.get('/admin/checkin')).text, /Helping at the door: Hetal/);

  // It isn't a member login.
  const member = new t.Client();
  await member.get('/login');
  r = await member.post('/login', { email: 'door', password: 'garba25' });
  assert.equal(r.status, 403);
  assert.match(r.text, /used on the Committee &amp; volunteer sign-in/);

  // Changing the password signs out every phone using the old one; the new one works.
  await admin.post('/admin/door-login', { password: 'raas26' });
  assert.match((await door.get('/admin/checkin')).location, /\/admin\/login/);
  assert.equal((await doorSignIn('door', 'garba25')).res.status, 401);
  assert.equal((await doorSignIn('door', 'raas26')).res.location, '/admin/checkin/name');

  // Turned off: nobody can use it until it's turned on again.
  const { c: still } = await doorSignIn('door', 'raas26');
  await admin.post('/admin/door-login/off', {});
  assert.match((await still.get('/admin/checkin')).location, /\/admin\/login/);
  r = (await doorSignIn('door', 'raas26')).res;
  assert.equal(r.status, 403);
  assert.match(r.text, /shared door login is turned off/);
  assert.match((await admin.get('/admin/checkin')).text, /Shared door login[\s\S]*Off/);
});

test('in the demo, the shared door login keeps demo1234 behind its sign-in button', async () => {
  const demo = await startTestApp({ demoMode: true });
  try {
    const c = new demo.Client();
    let res = await c.get('/admin/login');
    assert.match(res.text, /Door team \(shared login\)/);
    res = await c.post('/admin/login', { email: 'door', password: 'demo1234' });
    assert.equal(res.location, '/admin/checkin/name');
    const a = await demo.adminLogin('admin@example.com', 'demo1234');
    res = await a.follow(await a.post('/admin/door-login', { password: 'raas26' }));
    assert.match(res.text, /keeps the password demo1234/);
  } finally { demo.close(); }
});
