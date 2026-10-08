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

const userId = (email) => t.db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
const payDemo = async (client, res) => client.post(`/pay/${Number(res.location.match(/\/pay\/(\d+)\/demo/)[1])}/demo`);

// ---------- Events ----------

test('guests pay the guest price; non-members pay it for themselves', async () => {
  const eventId = await t.createEvent(admin, { title: 'Dinner', fee: '15', allow_guests: '1', guest_fee: '20', max_guests: '2' });
  const member = await t.register('guests@test.org', 'Gita', 1); // member + 1 child, Family level
  let res = await member.post(`/events/${eventId}/rsvp`, { party_size: '2', guests: '2' });
  assert.match(res.location, /\/pay\/\d+\/demo/);
  let r = t.rsvpFor(eventId, 'guests@test.org');
  assert.equal(r.party_size, 4);
  assert.equal(r.guest_count, 2);
  assert.equal(r.total_cents, 2 * 1500 + 2 * 2000);

  res = await member.follow(await member.post(`/events/${eventId}/rsvp`, { party_size: '2', guests: '3' }));
  assert.match(res.text, /up to 2 guests/);

  const nonMember = await t.register('nonmember@test.org');
  await nonMember.post(`/events/${eventId}/rsvp`, { party_size: '1' });
  assert.equal(t.rsvpFor(eventId, 'nonmember@test.org').total_cents, 2000);

  // Check-in screen shows the family/guest split.
  await payDemo(member, await member.post(`/events/${eventId}/pay`));
  r = t.rsvpFor(eventId, 'guests@test.org');
  res = await admin.get(`/admin/checkin/${r.qr_token}`);
  assert.match(res.text, /2 family \+ 2 guests/);

  const noGuests = await t.createEvent(admin, { title: 'Members night' });
  res = await member.follow(await member.post(`/events/${noGuests}/rsvp`, { party_size: '1', guests: '1' }));
  assert.match(res.text, /does not allow guests/);
});

test('early-bird price and coupon codes', async () => {
  const eventId = await t.createEvent(admin, {
    title: 'Early Dinner', fee: '15', early_fee: '12', early_until: t.futureDate(3, '23:59'),
  });
  const member = await t.register('early@test.org', 'Esha', 1);
  await member.post(`/events/${eventId}/rsvp`, { party_size: '2' });
  assert.equal(t.rsvpFor(eventId, 'early@test.org').total_cents, 2400);

  let res = await admin.post(`/admin/events/${eventId}/coupons`, { code: 'half', kind: 'percent', value: '50', max_uses: '1' });
  assert.equal(res.status, 302);
  res = await member.follow(await member.post(`/events/${eventId}/rsvp`, { party_size: '2', coupon: 'NOPE' }));
  assert.match(res.text, /not valid for this event/);
  await member.post(`/events/${eventId}/rsvp`, { party_size: '2', coupon: 'HALF' });
  const r = t.rsvpFor(eventId, 'early@test.org');
  assert.equal(r.discount_cents, 1200);
  assert.equal(r.total_cents, 1200);
  assert.equal(r.coupon_code, 'HALF');

  const other = await t.register('early2@test.org', 'Ekta', 1);
  res = await other.follow(await other.post(`/events/${eventId}/rsvp`, { party_size: '1', coupon: 'HALF' }));
  assert.match(res.text, /fully used/);

  res = await admin.get(`/admin/events/${eventId}`);
  assert.match(res.text, /HALF/);
});

test('waitlist: full events take a waitlist that fills automatically', async () => {
  const eventId = await t.createEvent(admin, { title: 'Small Workshop', capacity: '3' });
  const a = await t.register('wa@test.org', 'Asha', 2);
  const b = await t.register('wb@test.org', 'Bina', 1);
  await a.post(`/events/${eventId}/rsvp`, { party_size: '3' });

  let res = await b.follow(await b.post(`/events/${eventId}/rsvp`, { party_size: '2' }));
  assert.match(res.text, /join the waitlist/);
  assert.equal(t.rsvpFor(eventId, 'wb@test.org'), undefined);

  res = await b.follow(await b.post(`/events/${eventId}/rsvp`, { party_size: '2', waitlist: '1' }));
  assert.match(res.text, /on the waitlist/);
  let rb = t.rsvpFor(eventId, 'wb@test.org');
  assert.equal(rb.status, 'waitlisted');
  // A waitlisted RSVP has no usable ticket.
  await admin.post(`/admin/checkin/${rb.qr_token}`, { guests: '2' });
  assert.equal(t.rsvpFor(eventId, 'wb@test.org').checked_in_at, null);
  assert.match((await admin.get(`/admin/events/${eventId}`)).text, /Waitlist<\/div><div class="value">2/);

  // A cancels -> B moves in automatically.
  await a.post(`/events/${eventId}/cancel`);
  rb = t.rsvpFor(eventId, 'wb@test.org');
  assert.equal(rb.status, 'confirmed');
  assert.match((await b.get(`/tickets/${rb.id}`)).text, /data:image\/png;base64/);
});

test('raising capacity moves people off the waitlist', async () => {
  const eventId = await t.createEvent(admin, { title: 'Tiny Event', capacity: '1' });
  const a = await t.register('cap1@test.org');
  const b = await t.register('cap2@test.org');
  await a.post(`/events/${eventId}/rsvp`, { party_size: '1' });
  await b.post(`/events/${eventId}/rsvp`, { party_size: '1', waitlist: '1' });
  assert.equal(t.rsvpFor(eventId, 'cap2@test.org').status, 'waitlisted');
  const res = await admin.follow(await admin.post(`/admin/events/${eventId}`, {
    title: 'Tiny Event', starts_at: t.futureDate(10), fee: '0', max_party_size: '6', status: 'published', capacity: '2',
  }));
  assert.match(res.text, /1 RSVP moved off the waitlist/);
  assert.equal(t.rsvpFor(eventId, 'cap2@test.org').status, 'confirmed');
});

test('custom registration questions are required, stored and exported', async () => {
  const eventId = await t.createEvent(admin, { title: 'Q Event', questions: '*Dietary preference: Regular, Jain\nT-shirt size' });
  const m = await t.register('q@test.org', 'Quinn');
  let res = await m.get(`/events/${eventId}`);
  assert.match(res.text, /Dietary preference \*/);
  res = await m.follow(await m.post(`/events/${eventId}/rsvp`, { party_size: '1' }));
  assert.match(res.text, /Please answer: Dietary preference/);
  res = await m.follow(await m.post(`/events/${eventId}/rsvp`, { party_size: '1', q_0: 'Pizza' }));
  assert.match(res.text, /choose an option/);
  await m.post(`/events/${eventId}/rsvp`, { party_size: '1', q_0: 'Jain', q_1: 'M' });
  assert.deepEqual(JSON.parse(t.rsvpFor(eventId, 'q@test.org').answers).map((a) => a.answer), ['Jain', 'M']);
  res = await admin.get(`/admin/events/${eventId}/attendees.csv`);
  assert.match(res.text, /Dietary preference,T-shirt size/);
  assert.match(res.text, /,Jain,M,/);
});

test('event photo upload, calendar view and add-to-calendar file', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  let res = await admin.upload('/admin/events', {
    title: 'Photo Event', starts_at: t.futureDate(5, '19:00'), fee: '0', max_party_size: '4', status: 'published',
  }, { field: 'image', content: png, type: 'image/png', name: 'flyer.png' });
  assert.equal(res.status, 302);
  const eventId = Number(res.location.split('/').pop());
  const event = t.db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  assert.match(event.image_path, /^\/uploads\/[0-9a-f]+\.png$/);
  assert.equal((await fetch(t.base + event.image_path)).status, 200);

  res = await admin.follow(await admin.upload('/admin/events', {
    title: 'Bad', starts_at: t.futureDate(5), fee: '0', max_party_size: '4',
  }, { field: 'image', content: 'hello', type: 'text/plain', name: 'x.txt' }));
  assert.match(res.text, /JPG, PNG, WebP or GIF/);

  // Upload forms without the token are rejected.
  const forged = await admin.request('POST', '/admin/events', new FormData());
  assert.equal(forged.status, 403);

  const m = await t.register('cal@test.org');
  res = await m.get(`/events?view=calendar&month=${event.starts_at.slice(0, 7)}`);
  assert.match(res.text, /Photo Event/);
  res = await m.get(`/events/${eventId}/calendar.ics`);
  assert.match(res.headers.get('content-type'), /text\/calendar/);
  assert.match(res.text, /SUMMARY:Photo Event/);
  assert.match(res.text, /DTSTART:\d{8}T190000/);
});

// ---------- Contacts ----------

test('contact database: add contacts without email or login, tag and filter them', async () => {
  let res = await admin.post('/admin/members/new', { first_name: 'Kokila', last_name: 'Volunteer', city: 'Conway', tags: 'Volunteer' });
  assert.equal(res.status, 302);
  res = await admin.post('/admin/members/new', {
    email: 'sponsor@bank.example', first_name: 'Laura', last_name: 'Sponsor', tags: ['Sponsor', 'Bogus'], create_login: '1',
  });
  res = await admin.follow(res);
  assert.match(res.text, /Temporary password: (\S+)/);
  const temp = res.text.match(/Temporary password: (\S+)/)[1];
  assert.equal(t.db.prepare(`SELECT tags FROM users WHERE email = 'sponsor@bank.example'`).get().tags, 'Sponsor');
  await t.login('sponsor@bank.example', temp); // their login works

  res = await admin.get('/admin/members?tag=Volunteer');
  assert.match(res.text, /Volunteer, Kokila/);
  assert.doesNotMatch(res.text, /Sponsor, Laura/);
  res = await admin.get('/admin/members?status=none&login=no');
  assert.match(res.text, /Volunteer, Kokila/);
  res = await admin.get('/admin/members.csv?tag=Sponsor');
  assert.match(res.text, /Laura,Sponsor,sponsor@bank\.example/);

  // Contacts without a login can't sign in, and don't show in the member directory.
  const member = await t.register('dirviewer@test.org');
  res = await member.get('/directory?q=Kokila');
  assert.doesNotMatch(res.text, /<strong>Kokila/);
});

test('import contacts from a WildApricot CSV export', async () => {
  await t.register('existing@test.org', 'Old');
  const csv = [
    'User ID,First name,Last name,Email,Phone,City,Membership level,Membership status,Member since,Renewal due',
    `1,Ramesh,Mody,ramesh@test.org,501-555-1111,Cabot,Family,Active,2019-03-01,${new Date().getFullYear() + 1}-01-01`,
    '2,Updated,Name,existing@test.org,501-555-2222,Bryant,,,,',
    '3,,NoFirstName,nofirst@test.org,,,,,,',
    '4,"Patel, Jr",Hetal,,,"Little Rock",Married Couple,Lapsed,,01/01/2024',
  ].join('\r\n');
  let res = await admin.upload('/admin/import', {}, { field: 'file', content: csv, type: 'text/csv', name: 'contacts.csv' });
  assert.equal(res.status, 200);
  assert.match(res.text, /New contacts<\/div><div class="value">2/);
  assert.match(res.text, /Updated<\/div><div class="value">1/);
  assert.match(res.text, /Memberships recorded<\/div><div class="value">2/);
  assert.match(res.text, /Row 4: First and last name are required/);

  const ramesh = t.db.prepare(`SELECT * FROM users WHERE email = 'ramesh@test.org'`).get();
  assert.equal(ramesh.password_hash, null);
  assert.equal(ramesh.source, 'import');
  const m = t.db.prepare('SELECT * FROM memberships WHERE user_id = ?').get(ramesh.id);
  assert.equal(m.end_date, `${new Date().getFullYear()}-12-31`);
  assert.equal(m.start_date, '2019-03-01');
  assert.equal(t.db.prepare(`SELECT phone FROM users WHERE email = 'existing@test.org'`).get().phone, '501-555-2222');
  const lapsed = t.db.prepare(`SELECT m.end_date FROM memberships m JOIN users u ON u.id = m.user_id WHERE u.first_name = 'Patel, Jr'`).get();
  assert.equal(lapsed.end_date, '2023-12-31');

  // Imported people can't claim the account themselves yet; an admin creates their login.
  const visitor = new t.Client();
  await visitor.get('/register');
  res = await visitor.post('/register', { email: 'ramesh@test.org', password: 'whatever1', password_confirm: 'whatever1', first_name: 'R', last_name: 'M' });
  assert.match(res.text, /already in our member records/);
  res = await visitor.post('/login', { email: 'ramesh@test.org', password: '' });
  assert.equal(res.status, 401);
  res = await admin.follow(await admin.post(`/admin/members/${ramesh.id}/reset-password`));
  const temp = res.text.match(/Temporary password: (\S+)/)[1];
  await t.login('ramesh@test.org', temp);
});

// ---------- Donations, receipts, reports ----------

test('donations to a fund, with receipt, progress and admin donor list', async () => {
  let res = await admin.post('/admin/campaigns', { title: 'Facility Fund', goal: '1000' });
  const fundId = t.db.prepare(`SELECT id FROM campaigns WHERE title = 'Facility Fund'`).get().id;
  const donor = await t.register('donor@test.org', 'Dev');
  res = await donor.follow(await donor.post('/donate', { campaign_id: String(fundId), amount: 'other', other_amount: '0.50' }));
  assert.match(res.text, /at least \$1/);
  res = await donor.post('/donate', { campaign_id: String(fundId), amount: '25100', note: 'For the kitchen' });
  res = await payDemo(donor, res);
  assert.match(res.location, /^\/receipts\/\d+$/);
  res = await donor.get(res.location);
  assert.match(res.text, /Donation receipt/);
  assert.match(res.text, /501\(c\)\(3\)/);
  assert.match(res.text, /No goods or services were provided/);
  assert.match(res.text, /\$251\.00/);

  // Someone else can't see this receipt.
  const other = await t.register('snoop@test.org');
  const receiptId = t.db.prepare(`SELECT id FROM payments WHERE kind = 'donation' AND user_id = ?`).get(userId('donor@test.org')).id;
  assert.equal((await other.get(`/receipts/${receiptId}`)).status, 404);

  res = await donor.get('/donate');
  assert.match(res.text, /\$251\.00<\/strong> raised of \$1,000\.00 goal/);
  assert.match(res.text, /25% of goal/);

  res = await admin.get(`/admin/donations?campaign=${fundId}`);
  assert.match(res.text, /For the kitchen/);
  res = await admin.get('/admin/donations.csv?q=Dev');
  assert.match(res.text, /Facility Fund,\$251\.00,demo/);

  // Admin records a cash donation for someone at the door.
  await admin.post(`/admin/members/${userId('snoop@test.org')}/payments`, { kind: 'donation', amount: '51', method: 'cash', description: 'Diwali' });
  res = await admin.get('/admin/donations?campaign=general');
  assert.match(res.text, /\$51\.00/);
});

test('financial report, QuickBooks export and trends dashboard', async () => {
  const year = String(new Date().getFullYear());
  const m = await t.register('report@test.org');
  const uid = userId('report@test.org');
  t.db.prepare(`INSERT INTO payments (user_id, kind, description, amount_cents, status, method, paid_at)
                VALUES (?, 'donation', 'Donation — General fund', 10100, 'paid', 'check', ?)`).run(uid, `${year}-02-10 12:00:00`);
  grantMembership(t.db, { userId: uid, planId: t.planId('Individual') });

  let res = await admin.get(`/admin/reports?year=${year}`);
  assert.equal(res.status, 200);
  assert.match(res.text, /Income by month/);
  assert.match(res.text, /<svg/);
  res = await admin.get(`/admin/reports/quickbooks.csv?year=${year}`);
  assert.match(res.text, /^Date,Transaction Type,Num,Customer,Item,Memo,Payment Method,Ref No,Amount/);
  assert.match(res.text, new RegExp(`02/10/${year},Sales Receipt,GSA-\\d{6},Test Member,Donations,`));

  res = await admin.get('/admin/insights');
  assert.match(res.text, /New members per month/);
  assert.match(res.text, /Active memberships by level/);
  assert.match(res.text, /Show as table/);

  assert.equal((await m.get('/admin/reports')).status, 403);
});

// ---------- Website editor & app ----------

test('admins edit the public website content', async () => {
  let res = await admin.post('/admin/site/org', {
    shortName: 'GSA', motto: 'Seva is our strength', founded: '1989', address1: '1 GSA Circle', address2: 'Little Rock, AR 72209',
    phone: '(501) 916-2416', email: 'gsaarkansas@gmail.com', venue: 'GSA Community Center', ein: '12-3456789',
  });
  assert.equal(res.status, 302);
  await admin.post('/admin/site/committee', { committee: '## Executive Committee\nAnil Patel | President | Little Rock | Bahumara\nNew Person |  | Cabot | Ruva' });
  // Sponsors come from Contacts → Sponsors & vendors (only those shown on the website).
  await admin.post('/admin/members/new', { contact_type: 'business', organization: 'Acme Sweets', sponsor_level: 'Gold', show_on_website: '1', website: 'acmesweets.example.com', tags: 'Sponsor' });
  await admin.post('/admin/members/new', { contact_type: 'business', organization: 'Quiet Vendor LLC', tags: 'Vendor' });

  const anon = new t.Client();
  res = await anon.get('/about');
  assert.match(res.text, /Seva is our strength/);
  res = await anon.get('/committee');
  assert.match(res.text, /New Person/);
  assert.doesNotMatch(res.text, /Board of Trustees/);
  res = await anon.get('/sponsors');
  assert.match(res.text, /tier-gold">Gold<\/span> Level[\s\S]*?href="https:\/\/acmesweets\.example\.com" target="_blank" rel="noopener noreferrer">Acme Sweets</);
  assert.doesNotMatch(res.text, /Quiet Vendor/);

  // EIN shows on donation receipts.
  const donor = await t.register('ein@test.org');
  res = await payDemo(donor, await donor.post('/donate', { amount: '2100' }));
  assert.match((await donor.get(res.location)).text, /EIN 12-3456789/);

  res = await admin.get('/admin/site');
  assert.match(res.text, /New Person \|  \| Cabot \| Ruva/);
});

test('installable app: manifest, service worker and offline page', async () => {
  let res = await fetch(`${t.base}/manifest.webmanifest`);
  const manifest = await res.json();
  assert.equal(manifest.short_name, 'GSA');
  assert.equal(manifest.display, 'standalone');
  res = await fetch(`${t.base}/sw.js`);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.equal((await fetch(`${t.base}/offline.html`)).status, 200);
  assert.equal((await fetch(`${t.base}/icon-512.png`)).status, 200);
  const m = await t.register('pwa@test.org');
  res = await m.get('/dashboard');
  assert.match(res.text, /rel="manifest"/);
  assert.match(res.text, /id="install-card"/);
});
