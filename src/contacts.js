// Contact database: members and everyone else the samaj keeps in touch with (donors, sponsors,
// vendors, volunteers, former members). Contacts may have no email and no login.
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { transaction } = require('./db');
const { UserError, cleanProfile, PROFILE_FIELDS, periodEnd } = require('./services');
const { today } = require('./util');

const TAGS = ['Donor', 'Sponsor', 'Vendor', 'Volunteer', 'Committee', 'Guest'];
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
    throw new UserError('A contact with that email already exists.');
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

module.exports = { TAGS, cleanTags, cleanEmail, addContact, temporaryPassword, parseCsv, importContacts };
