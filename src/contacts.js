// Contact database: members and everyone else the samaj keeps in touch with (donors, sponsors,
// vendors, volunteers, former members). Contacts may have no email and no login.
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { transaction } = require('./db');
const { UserError, cleanProfile, PROFILE_FIELDS, periodEnd } = require('./services');
const { today } = require('./util');

const TAGS = ['Donor', 'Sponsor', 'Vendor', 'Volunteer', 'Committee', 'Guest'];
// Sponsorship levels, highest first: the order of the public Sponsors page.
const SPONSOR_LEVELS = ['Platinum', 'Gold', 'Silver', 'Bronze', 'Community partner'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  return [...new Set(list.map((t) => t.trim()).filter((t) => TAGS.includes(t)))].join(',');
}

function cleanEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (e && !EMAIL_RE.test(e)) throw new UserError(`"${e}" is not a valid email address.`);
  return e || null;
}

// Short random password an admin hands to someone so they can sign in for the first time.
function temporaryPassword() {
  return crypto.randomBytes(6).toString('base64url');
}

function addContact(db, body) {
  const profile = cleanProfile(body);
  const email = cleanEmail(body.email);
  if (email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
    throw new UserError('That email is already used by someone else in the app.');
  }
  const temp = body.create_login && email ? temporaryPassword() : null;
  const id = Number(db.prepare(`INSERT INTO users (email, password_hash, role, ${PROFILE_FIELDS.join(', ')}, notes, tags, source)
    VALUES (?, ?, 'member', ${PROFILE_FIELDS.map(() => '?').join(', ')}, ?, ?, 'admin')`)
    .run(email, temp ? bcrypt.hashSync(temp, 10) : null, ...PROFILE_FIELDS.map((f) => profile[f]),
      String(body.notes || '').slice(0, 2000) || null, cleanTags(body.tags)).lastInsertRowid);
  return { id, temporaryPassword: temp };
}

// ---------- CSV import (e.g. a WildApricot contacts export) ----------

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  text = String(text).replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}

// Column names we recognise (WildApricot export names and common alternatives).
const COLUMNS = {
  first_name: ['first name', 'firstname', 'first'],
  last_name: ['last name', 'lastname', 'last', 'surname'],
  email: ['email', 'e-mail', 'email address'],
  phone: ['phone', 'mobile', 'mobile phone', 'cell', 'phone number', 'home phone'],
  address_line1: ['address', 'street address', 'address 1', 'address line 1', 'street'],
  address_line2: ['address 2', 'address line 2'],
  city: ['city', 'town'],
  state: ['state', 'province', 'state/province'],
  postal_code: ['zip', 'zip code', 'postal code', 'postcode', 'zip/postal code'],
  native_place: ['native place', 'vatan', 'village', 'native village'],
  level: ['membership level', 'level', 'membership'],
  status: ['membership status', 'status'],
  renewal_due: ['renewal due', 'renewal date', 'expires', 'expiry date', 'membership expires'],
  member_since: ['member since', 'joined'],
  tags: ['tags', 'groups', 'type'],
  notes: ['notes', 'note', 'comments'],
};

function mapHeader(header) {
  const map = {};
  header.forEach((h, i) => {
    const name = h.trim().toLowerCase();
    for (const [key, aliases] of Object.entries(COLUMNS)) {
      if (map[key] === undefined && aliases.includes(name)) map[key] = i;
    }
  });
  return map;
}

// Accepts 2026-12-31, 12/31/2026 or 31 Dec 2026; returns YYYY-MM-DD or null.
function parseDate(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  let m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function dayBefore(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Imports contacts from CSV text. Existing contacts (matched by email) are updated, new ones added.
 * When a row has a membership level that matches one of ours, the membership is recorded too:
 * it runs until the day before "Renewal due" (or the end of the level's period).
 */
function importContacts(db, csvText) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw new UserError('The file has no contacts in it.');
  const col = mapHeader(rows[0]);
  if (col.first_name === undefined || col.last_name === undefined) {
    throw new UserError('The file needs "First name" and "Last name" columns.');
  }
  const plans = db.prepare('SELECT * FROM membership_plans').all();
  const result = { created: 0, updated: 0, memberships: 0, skipped: [] };
  const get = (r, key) => (col[key] === undefined ? '' : String(r[col[key]] ?? '').trim());

  transaction(db, () => {
    rows.slice(1).forEach((r, index) => {
      const line = index + 2;
      try {
        const profile = cleanProfile(Object.fromEntries(PROFILE_FIELDS.map((f) => [f, get(r, f)])));
        const email = cleanEmail(get(r, 'email'));
        const tags = cleanTags(get(r, 'tags'));
        const existing = email ? db.prepare('SELECT * FROM users WHERE email = ?').get(email) : null;
        let userId;
        if (existing) {
          // Only fill in what the file provides; never wipe data members entered themselves.
          const sets = PROFILE_FIELDS.filter((f) => profile[f]);
          if (sets.length) {
            db.prepare(`UPDATE users SET ${sets.map((f) => `${f} = ?`).join(', ')}, updated_at = datetime('now') WHERE id = ?`)
              .run(...sets.map((f) => profile[f]), existing.id);
          }
          if (tags) db.prepare('UPDATE users SET tags = ? WHERE id = ?').run(cleanTags([...existing.tags.split(','), ...tags.split(',')]), existing.id);
          userId = existing.id;
          result.updated++;
        } else {
          userId = Number(db.prepare(`INSERT INTO users (email, role, ${PROFILE_FIELDS.join(', ')}, notes, tags, source)
            VALUES (?, 'member', ${PROFILE_FIELDS.map(() => '?').join(', ')}, ?, ?, 'import')`)
            .run(email, ...PROFILE_FIELDS.map((f) => profile[f]), get(r, 'notes').slice(0, 2000) || null, tags).lastInsertRowid);
          result.created++;
        }

        const levelName = get(r, 'level').toLowerCase();
        const plan = levelName && plans.find((p) => p.name.toLowerCase() === levelName)
          || (levelName && plans.find((p) => p.name.toLowerCase().includes(levelName) || levelName.includes(p.name.toLowerCase())));
        if (plan) {
          const renewal = parseDate(get(r, 'renewal_due'));
          const since = parseDate(get(r, 'member_since'));
          const end = renewal ? dayBefore(renewal) : periodEnd(plan, today());
          const start = since && since <= end ? since : `${end.slice(0, 4)}-01-01`;
          const already = db.prepare('SELECT 1 FROM memberships WHERE user_id = ? AND end_date = ?').get(userId, end);
          if (!already) {
            db.prepare('INSERT INTO memberships (user_id, plan_id, start_date, end_date) VALUES (?, ?, ?, ?)').run(userId, plan.id, start, end);
            result.memberships++;
          }
        }
      } catch (err) {
        if (!(err instanceof UserError)) throw err;
        result.skipped.push(`Row ${line}: ${err.message}`);
      }
    });
  });
  return result;
}

// ---------- Sponsors & vendors ----------
// Kept apart from members (contact_type 'business'): no login, not counted as members, own tab in Contacts.
// The organization's name is stored in first_name (last_name empty) so payments and receipts show it.

function businessFields(body) {
  const organization = String(body.organization || '').trim().slice(0, 200);
  if (!organization) throw new UserError('Please enter the business or organization name.');
  let website = String(body.website || '').trim().slice(0, 300);
  if (website && !/^https?:\/\//i.test(website)) website = `https://${website}`;
  if (website) {
    try { new URL(website); } catch { throw new UserError('That website address doesn\'t look right.'); }
  }
  const year = String(body.sponsor_year || '').trim();
  const sponsorYear = year ? Number(year) : null;
  if (year && !(Number.isInteger(sponsorYear) && sponsorYear >= 1990 && sponsorYear <= 2100)) throw new UserError('Please enter the sponsorship year, e.g. 2026.');
  const text = (k, max = 200) => String(body[k] || '').trim().slice(0, max) || null;
  return {
    first_name: organization, contact_person: text('contact_person'), phone: text('phone'), website: website || null,
    address_line1: text('address_line1'), address_line2: text('address_line2'), city: text('city'), state: text('state'),
    postal_code: text('postal_code'), sponsor_level: SPONSOR_LEVELS.includes(body.sponsor_level) ? body.sponsor_level : null,
    sponsor_year: sponsorYear, show_on_website: body.show_on_website ? 1 : 0, notes: text('notes', 2000), tags: cleanTags(body.tags),
  };
}

function addBusiness(db, body) {
  const fields = businessFields(body);
  const email = cleanEmail(body.email);
  if (email && db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new UserError('That email is already used by someone else in the app.');
  const cols = Object.keys(fields);
  return Number(db.prepare(`INSERT INTO users (email, last_name, contact_type, source, ${cols.join(', ')})
    VALUES (?, '', 'business', 'admin', ${cols.map(() => '?').join(', ')})`).run(email, ...Object.values(fields)).lastInsertRowid);
}

function updateBusiness(db, id, body) {
  const fields = businessFields(body);
  const email = cleanEmail(body.email);
  if (email && db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, id)) throw new UserError('That email is already used by someone else in the app.');
  db.prepare(`UPDATE users SET email = ?, ${Object.keys(fields).map((k) => `${k} = ?`).join(', ')}, updated_at = datetime('now')
    WHERE id = ? AND contact_type = 'business'`).run(email, ...Object.values(fields), id);
}

// Moves a contact between Members and Sponsors & vendors (e.g. one put in the wrong list).
function setContactType(db, id, type) {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!u) return;
  if (type === 'business') {
    if (u.password_hash || u.role === 'admin' || u.owner_id) throw new UserError('This contact signs in to the member app, so they stay a member.');
    const name = `${u.first_name} ${u.last_name}`.trim();
    db.prepare(`UPDATE users SET contact_type = 'business', first_name = ?, last_name = '', contact_person = COALESCE(contact_person, ?) WHERE id = ?`)
      .run(name, name, id);
  } else {
    const person = String(u.contact_person || u.first_name).trim().split(/\s+/);
    db.prepare(`UPDATE users SET contact_type = 'member', first_name = ?, last_name = ?, show_on_website = 0 WHERE id = ?`)
      .run(person[0] || u.first_name, person.slice(1).join(' '), id);
  }
}

// One-time move of the old typed-in website sponsor list into sponsor contacts (shown on the website).
function importWebsiteSponsors(db) {
  if (db.prepare(`SELECT 1 FROM pages WHERE key = 'sponsors_imported'`).get()) return;
  const { getContent } = require('./site');
  const tiers = getContent(db, 'sponsors') || [];
  for (const { tier, names } of tiers) {
    for (const name of names || []) {
      if (db.prepare(`SELECT 1 FROM users WHERE contact_type = 'business' AND first_name = ? COLLATE NOCASE`).get(name)) continue;
      db.prepare(`INSERT INTO users (first_name, last_name, contact_type, sponsor_level, show_on_website, tags, source)
        VALUES (?, '', 'business', ?, 1, 'Sponsor', 'admin')`).run(name, SPONSOR_LEVELS.includes(tier) ? tier : null);
    }
  }
  db.prepare(`INSERT OR REPLACE INTO pages (key, value, updated_at) VALUES ('sponsors_imported', 'true', datetime('now'))`).run();
}

// The public Sponsors page: sponsors marked "Show on the website", grouped by level (highest first).
function websiteSponsors(db) {
  const rows = db.prepare(`SELECT first_name AS name, website, sponsor_level FROM users
    WHERE contact_type = 'business' AND show_on_website = 1 ORDER BY first_name COLLATE NOCASE`).all();
  const levels = [...SPONSOR_LEVELS, null];
  return levels.map((level) => ({ tier: level || 'Sponsors', sponsors: rows.filter((r) => (SPONSOR_LEVELS.includes(r.sponsor_level) ? r.sponsor_level : null) === level) }))
    .filter((g) => g.sponsors.length);
}

module.exports = {
  SPONSOR_LEVELS, addBusiness, updateBusiness, setContactType, importWebsiteSponsors, websiteSponsors, TAGS, cleanTags, cleanEmail, addContact, temporaryPassword, parseCsv, importContacts };
