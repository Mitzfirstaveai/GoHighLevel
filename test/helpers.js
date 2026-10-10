// Shared test harness: starts the app on an in-memory database and provides a tiny
// cookie-keeping browser plus helpers for common flows.
// Run tests in the org's time zone (production sets TZ=America/Chicago on Render).
process.env.TZ = 'America/Chicago';
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');
const { loadConfig } = require('../src/config');
const { grantMembership } = require('../src/services');

const PLANS_SQL = `INSERT INTO membership_plans (name, amount_cents, duration_months, calendar_year, spouse_allowed, children_allowed, max_parents, min_age)
  VALUES ('Senior Citizen', 11000, 12, 1, 0, 0, 0, 65), ('Individual', 16500, 12, 1, 0, 0, 0, 18),
         ('Married Couple', 27500, 12, 1, 1, 0, 0, 0), ('Family', 33000, 12, 1, 1, 1, 0, 0),
         ('Family with Parents', 38500, 12, 1, 1, 1, 2, 0)`;

async function startTestApp(overrides = {}) {
  const app = createApp(loadConfig({
    databaseFile: ':memory:', adminEmail: 'admin@test.org', adminPassword: 'Mango#Ledger2026',
    stripeSecretKey: '', allowDemoPayments: true, baseUrl: 'http://test.local', orgName: 'Test Samaj', demoMode: false,
    ...overrides,
  }));
  const db = app.locals.db;
  if (!overrides.demoMode) db.exec(PLANS_SQL); // demo mode brings its own levels
  let server;
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  const base = `http://127.0.0.1:${server.address().port}`;

  class Client {
    constructor() { this.jar = {}; this.csrf = ''; }

    get cookie() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }

    async request(method, path, form, extraHeaders = {}) {
      const headers = { cookie: this.cookie, ...extraHeaders };
      let body;
      if (form instanceof FormData) {
        body = form;
      } else if (form) {
        headers['content-type'] = 'application/x-www-form-urlencoded';
        const params = new URLSearchParams({ _csrf: this.csrf });
        for (const [k, v] of Object.entries(form)) for (const one of [].concat(v)) params.append(k, one);
        body = params.toString();
      }
      const res = await fetch(base + path, { method, headers, body, redirect: 'manual' });
      for (const c of res.headers.getSetCookie()) {
        const [pair] = c.split(';');
        const i = pair.indexOf('=');
        this.jar[pair.slice(0, i)] = pair.slice(i + 1);
      }
      const text = await res.text();
      const m = text.match(/name="_csrf" value="([^"]+)"/);
      if (m) this.csrf = m[1];
      return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
    }

    get(path) { return this.request('GET', path); }

    async post(path, form = {}) {
      if (!this.csrf) await this.get('/login');
      return this.request('POST', path, form);
    }

    // Multipart upload; the CSRF token goes in the URL like the real upload forms.
    async upload(path, fields, file) {
      if (!this.csrf) await this.get('/login');
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, v);
      for (const f of [].concat(file ?? [])) fd.append(f.field, new Blob([f.content], { type: f.type }), f.name);
      return this.request('POST', `${path}${path.includes('?') ? '&' : '?'}_csrf=${encodeURIComponent(this.csrf)}`, fd);
    }

    async follow(res) {
      let r = res;
      while (r.location) r = await this.get(r.location);
      return r;
    }
  }

  async function login(email, password) {
    const c = new Client();
    await c.get('/login');
    const res = await c.post('/login', { email, password });
    assert.equal(res.status, 302, 'login should redirect');
    await c.get('/dashboard'); // refresh CSRF token for the new session
    return c;
  }

  // Admins work in the admin area, which they enter through the committee sign-in.
  async function adminLogin(email = 'admin@test.org', password = 'Mango#Ledger2026') {
    const c = new Client();
    await c.get('/admin/login');
    const res = await c.post('/admin/login', { email, password });
    assert.equal(res.status, 302, 'admin login should redirect');
    await c.get('/admin'); // refresh CSRF token for the new session
    return c;
  }

  const planId = (name) => db.prepare('SELECT id FROM membership_plans WHERE name = ?').get(name).id;

  // Everything a member has to fill in (sign-up and profile), with test values.
  const profile = (fields = {}) => ({
    first_name: 'Test', last_name: 'Member', phone: '501-555-0199', birth_month: '5', birth_year: '1985', native_place: 'Surat',
    address_line1: '1 Test St', city: 'Little Rock', state: 'AR', postal_code: '72201', ...fields,
  });

  async function register(email, first = 'Test', familyMembers = 0) {
    const c = new Client();
    await c.get('/register');
    const res = await c.post('/register', profile({
      email, password: 'Chai#Masala2026', password_confirm: 'Chai#Masala2026', first_name: first, last_name: 'Member',
    }));
    assert.equal(res.status, 302);
    await c.get('/profile');
    for (let i = 1; i <= familyMembers; i++) {
      await c.post('/profile/household', { name: `Child ${String.fromCharCode(64 + i)}`, relationship: i % 2 ? 'Son' : 'Daughter', birth_month: '6', birth_year: '2008' });
    }
    if (familyMembers) {
      // Family members only count toward event guests while covered by a paid membership.
      const userId = db.prepare('SELECT id FROM users WHERE email = ?').get(email).id;
      grantMembership(db, { userId, planId: planId('Family') });
    }
    return c;
  }

  function futureDate(days, time = '18:00') {
    const d = new Date(Date.now() + days * 86400000);
    return `${d.toISOString().slice(0, 10)}T${time}`;
  }

  async function createEvent(admin, fields) {
    const res = await admin.post('/admin/events', {
      // Like the new-event form: the morning-of reminder (9 AM) and the GSA announcement are ticked.
      title: 'Garba Night', starts_at: futureDate(10), fee: '0', max_party_size: '6', status: 'published', remind_day_of: '1', remind_day_of_time: '09:00', announce: '1', ...fields,
    });
    assert.equal(res.status, 302);
    return Number(res.location.split('/').pop());
  }

  function rsvpFor(eventId, email) {
    return db.prepare(`SELECT r.* FROM rsvps r JOIN users u ON u.id = r.user_id WHERE r.event_id = ? AND u.email = ?`)
      .get(eventId, email);
  }

  return {
    db, base, Client, login, adminLogin, register, profile, planId, futureDate, createEvent, rsvpFor, config: () => app.locals.config, close: () => server.close(),
  };
}

module.exports = { startTestApp };

// For upgrade tests: makes a database file look like an older version by dropping the columns
// added since, then setting user_version (the next openDb runs the upgrades again).
const ADDED_COLUMNS = {
  12: [['rsvps', 'pay_at_door']],
  14: [['household_members', 'birth_month'], ['events', 'out_of_state_fee_cents'], ['events', 'student_fee_cents'],
    ['events', 'child_free_age'], ['rsvps', 'guest_types']],
  15: [['users', 'birth_year'], ['users', 'birth_month'], ['users', 'birthday']],
  16: [['events', 'remind_day_of'], ['events', 'remind_day_before'], ['events', 'remind_week_before'], ['events', 'invite_at']],
  18: [['events', 'announce'], ['events', 'announce_note'], ['events', 'announce_note_gu']],
  19: [['users', 'password_temporary']],
  20: [['rsvps', 'checked_in_name'], ['payments', 'recorded_name']],
};
// Columns a later version removed (put back when rewinding to before it).
const REMOVED_COLUMNS = { 15: [['users', 'date_of_birth TEXT']] };
function rewindSchema(raw, version) {
  for (const [v, cols] of Object.entries(ADDED_COLUMNS)) {
    if (Number(v) > version) for (const [table, col] of cols) raw.exec(`ALTER TABLE ${table} DROP COLUMN ${col}`);
  }
  for (const [v, cols] of Object.entries(REMOVED_COLUMNS)) {
    if (Number(v) > version) for (const [table, col] of cols) raw.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
  }
  raw.exec(`PRAGMA user_version = ${version}`);
}
module.exports.rewindSchema = rewindSchema;

