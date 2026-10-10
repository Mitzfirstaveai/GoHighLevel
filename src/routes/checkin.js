// Door check-in, shared by administrators and door volunteers (members an admin has given
// check-in access, signed in at /admin/login). Volunteers see only these pages: the scanner,
// a name search for the day's events and the ticket result — no contact details, payments
// or other admin pages.
// Mounted at /admin/checkin because members' QR codes link to /admin/checkin/<code>.
const express = require('express');
const QRCode = require('qrcode');
const { requireCheckin, canCheckIn } = require('../middleware');
const svc = require('../services');
const { parseIntInRange, nowLocal } = require('../util');
const { doorAccount, cleanVolunteerName } = require('../door-login');

const router = express.Router();

const TOKEN = /^[A-Za-z0-9_-]{10,64}$/;
const SEARCH_DAYS = 7;

// A member who opens their own QR link (e.g. with the phone camera) is shown their ticket instead.
router.get('/:token', (req, res, next) => {
  if (!req.user || canCheckIn(req.user, req.session)) return next();
  const rsvp = svc.findRsvpByToken(req.app.locals.db, req.params.token);
  if (rsvp && rsvp.user_id === req.user.id) return res.redirect(`/tickets/${rsvp.id}`);
  next();
});

router.use(requireCheckin);

// The shared door login: each volunteer types their first name first; it's kept with every check-in and cash
// payment they record, and shown at the top of the door screen ("Helping at the door: Mitesh · Not you?").
const doorName = (req) => (req.session.doorShared ? req.session.doorName : null);
router.use((req, res, next) => {
  if (req.session.doorShared && !req.session.doorName && req.path !== '/name') return res.redirect('/admin/checkin/name');
  res.locals.doorName = doorName(req);
  next();
});

router.get('/name', (req, res) => {
  if (!req.session.doorShared) return res.redirect('/admin/checkin');
  res.render('admin/door_name', { title: 'Who is helping at the door?', name: req.session.doorName || '' });
});

router.post('/name', (req, res) => {
  if (!req.session.doorShared) return res.redirect('/admin/checkin');
  try {
    req.session.doorName = cleanVolunteerName(req.body.name);
  } catch (err) {
    if (!(err instanceof svc.UserError)) throw err;
    res.locals.flash = [{ type: 'error', message: req.t(err.template) }];
    return res.status(400).render('admin/door_name', { title: 'Who is helping at the door?', name: '' });
  }
  res.redirect('/admin/checkin');
});

function addDays(date, days) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Events from today through the next week, so volunteers can also get ready the day before.
function doorEvents(db) {
  const today = nowLocal().slice(0, 10);
  return db.prepare(`SELECT id, title, title_gu, starts_at FROM events
                     WHERE status = 'published' AND substr(starts_at, 1, 10) BETWEEN ? AND ?
                     ORDER BY starts_at LIMIT 8`).all(today, addDays(today, SEARCH_DAYS))
    .map((e) => ({ ...e, today: e.starts_at.slice(0, 10) === today, stats: svc.eventStats(db, e.id) }));
}

// Find a family by the member's name, a name on the ticket, a family member's name or phone digits.
function searchRsvps(db, eventId, query) {
  const q = query.trim();
  const digits = q.replace(/\D/g, '');
  if (q.length < 2) return [];
  const like = `%${q.replace(/[%_\\]/g, '\\$&')}%`;
  return db.prepare(`
    SELECT r.id, r.qr_token, r.party_size, r.guest_count, r.status, r.checked_in_at, r.checked_in_count, r.total_cents,
           (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p WHERE p.kind = 'event' AND p.reference_id = r.id AND p.status = 'paid') AS paid_cents,
           u.first_name, u.last_name, u.city
    FROM rsvps r JOIN users u ON u.id = r.user_id
    WHERE r.event_id = :event AND r.status != 'cancelled' AND (
      (u.first_name || ' ' || u.last_name) LIKE :like ESCAPE '\\' OR u.last_name LIKE :like ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM rsvp_attendees a WHERE a.rsvp_id = r.id AND a.name LIKE :like ESCAPE '\\')
      OR (NOT EXISTS (SELECT 1 FROM rsvp_attendees a2 WHERE a2.rsvp_id = r.id) -- older tickets without names
          AND EXISTS (SELECT 1 FROM household_members h WHERE h.user_id = COALESCE(u.owner_id, u.id) AND h.name LIKE :like ESCAPE '\\'))
      OR (length(:digits) >= 4 AND replace(replace(replace(replace(COALESCE(u.phone, ''), '-', ''), ' ', ''), '(', ''), ')', '') LIKE '%' || :digits || '%')
    )
    ORDER BY u.last_name, u.first_name LIMIT 25
  `).all({ event: eventId, like, digits: digits || '' }).map((r) => ({ ...r, names: svc.attendeeNames(db, r) }));
}

router.get('/', (req, res) => {
  const { db } = req.app.locals;
  const events = doorEvents(db);
  const selected = events.find((e) => e.id === Number(req.query.event)) || events[0] || null;
  const q = String(req.query.q || '').slice(0, 60);
  const results = selected && q ? searchRsvps(db, selected.id, q) : null;
  // Admins see who has door access, so they can add or remove volunteers.
  const volunteers = req.session.adminMode
    ? db.prepare(`SELECT id, first_name, last_name FROM users WHERE checkin_access = 1 AND role != 'admin' AND contact_type = 'member' ORDER BY first_name, last_name`).all()
    : [];
  const doorLogin = req.session.adminMode ? doorAccount(db) : null;
  // The family just checked in (Quick mode), confirmed inside the camera box.
  const confirm = req.session.doorConfirm;
  delete req.session.doorConfirm;
  const confirmation = confirm ? req.t(confirm.message, confirm.vars) : null;
  res.render('admin/checkin', { title: 'Door check-in', events, selected, q, results, volunteers, doorLogin, confirmation });
});

// Manual entry: the short code under the QR code (K7Q-3MX), a bare token or a pasted ticket link.
router.post('/lookup', (req, res) => {
  const raw = String(req.body.code || '').trim();
  if (raw.replace(/[\s-]/g, '').length === 6) {
    const found = svc.findTokenByShortCode(req.app.locals.db, raw, { today: nowLocal().slice(0, 10), days: SEARCH_DAYS });
    if (!found) throw new svc.UserError('No ticket with code {code} for this week\'s events. Check the code, or find the family by name.', { code: raw.toUpperCase() });
    return res.redirect(`/admin/checkin/${found}`);
  }
  const token = raw.split('/').filter(Boolean).pop() || '';
  if (!TOKEN.test(token)) throw new svc.UserError('That does not look like a valid ticket code.');
  res.redirect(`/admin/checkin/${token}`);
});

router.get('/:token', async (req, res) => {
  const { db, gateway, config } = req.app.locals;
  const rsvp = svc.findRsvpByToken(db, req.params.token);
  const due = rsvp ? svc.amountDue(db, rsvp) : 0;
  // Shown big at the door: paid (and how) or how much is still owed.
  const paid = rsvp ? db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS cents, group_concat(DISTINCT method) AS methods
    FROM payments WHERE kind = 'event' AND reference_id = ? AND status = 'paid'`).get(rsvp.id) : null;
  // Distinguishes "you just checked them in" from "this code was already used earlier".
  const justCheckedIn = req.session.justCheckedIn === req.params.token;
  delete req.session.justCheckedIn;
  const retired = rsvp ? null : svc.findRetiredToken(db, req.params.token);
  // Catch a ticket for another day's event (e.g. a Diwali ticket shown at Garba).
  const notToday = rsvp && rsvp.starts_at.slice(0, 10) !== nowLocal().slice(0, 10);
  const event = rsvp && db.prepare('SELECT title_gu FROM events WHERE id = ?').get(rsvp.event_id);
  // Still owing: a QR code the family scans to pay on their own phone (card, Apple/Google Pay, PayPal, Venmo).
  const payQr = rsvp && due && gateway.mode !== 'disabled' && ['confirmed', 'pending_payment'].includes(rsvp.status)
    ? await QRCode.toDataURL(`${config.baseUrl}/tickets/${rsvp.id}/pay`, { width: 240, margin: 2 }) : null;
  res.status(rsvp ? 200 : 404).render('admin/checkin_result', {
    payQr,
    title: 'Check-in', rsvp, retired, due, paid, justCheckedIn, notToday, token: req.params.token,
    names: rsvp ? svc.attendeeNames(db, rsvp) : [],
    people: rsvp ? svc.doorAttendees(db, rsvp) : [],
    guestKinds: rsvp ? JSON.parse(rsvp.guest_types || '{}') : {},
    childAge: rsvp ? svc.getEvent(db, rsvp.event_id).child_free_age : null,
    eventTitle: rsvp ? (req.lang === 'gu' && event.title_gu) || rsvp.event_title : '',
  });
});

// The door screen asks this every few seconds while a family pays on their phone, and turns green when it's paid.
router.get('/:token/due', (req, res) => {
  const { db } = req.app.locals;
  const rsvp = svc.findRsvpByToken(db, req.params.token);
  res.json({ due: rsvp ? svc.amountDue(db, rsvp) : 0 });
});

// After a successful check-in, Quick mode (the switch under the camera, sent with the form) goes straight back to
// the camera, with the green confirmation inside the camera box; otherwise the ticket page stays open with it.
function afterCheckIn(req, res, rsvp, back, message, vars) {
  if (req.body.quick !== '1') {
    req.flash('success', message, vars);
    return res.redirect(back);
  }
  req.session.doorConfirm = { message, vars };
  res.redirect(`/admin/checkin?event=${rsvp.event_id}#scanner`);
}

// Money collected at the door (cash, or Venmo / PayPal / Zelle sent to GSA's account; no checks) for a family that still owes. With `checkin`,
// the same tap also checks them in, so Quick mode goes straight back to the camera.
router.post('/:token/payment', (req, res) => {
  const { db } = req.app.locals;
  // Door volunteers can take cash (one tap marks it paid and checks the family in, with the volunteer's name).
  // Venmo, PayPal and Zelle sent to GSA's accounts are recorded by a committee member, who can check those
  // accounts; at the door, families pay those on their own phone with the QR code instead.
  if (!req.session.adminMode && req.body.method !== 'cash') {
    throw new svc.UserError('Door volunteers record cash only. For Venmo, PayPal or a card, have them scan the QR code and pay on their phone.');
  }
  const back = `/admin/checkin/${encodeURIComponent(req.params.token)}`;
  const rsvp = svc.findRsvpByToken(db, req.params.token);
  if (!rsvp) throw new svc.UserError('This QR code is not valid.');
  const method = String(req.body.method || 'cash');
  const { due } = svc.recordRsvpPayment(db, { rsvpId: rsvp.id, method, recordedBy: req.user.id, recordedName: doorName(req) });
  const vars = { amount: req.app.locals.money(due), method: req.t({ cash: 'cash', venmo: 'Venmo', paypal: 'PayPal', other: 'Zelle / other' }[method]) };
  if (!req.body.checkin) {
    req.flash('success', 'Recorded {amount} paid by {method}.', vars);
    return res.redirect(back);
  }
  const guests = parseIntInRange(req.body.guests, 1, 1000);
  try {
    const done = svc.checkIn(db, { token: req.params.token, guests, adminId: req.user.id, byName: doorName(req) });
    req.session.justCheckedIn = req.params.token;
    return afterCheckIn(req, res, done, back, guests === 1 ? 'Recorded {amount} paid by {method} and checked in {name} — 1 person.'
      : 'Recorded {amount} paid by {method} and checked in {name} — {n} people.', { ...vars, name: `${done.first_name} ${done.last_name}`, n: guests });
  } catch (err) {
    if (!(err instanceof svc.UserError)) throw err;
    req.flash('success', 'Recorded {amount} paid by {method}.', vars);
    req.flash('error', err.template, err.vars);
  }
  res.redirect(back);
});

router.post('/:token', (req, res) => {
  const { db } = req.app.locals;
  const guests = parseIntInRange(req.body.guests, 1, 1000);
  const back = `/admin/checkin/${encodeURIComponent(req.params.token)}`;
  let rsvp;
  try {
    rsvp = svc.checkIn(db, { token: req.params.token, guests, adminId: req.user.id, byName: doorName(req) });
  } catch (err) {
    if (!(err instanceof svc.UserError)) throw err;
    delete req.session.justCheckedIn;
    req.flash('error', err.template, err.vars);
    return res.redirect(back);
  }
  req.session.justCheckedIn = req.params.token;
  afterCheckIn(req, res, rsvp, back, guests === 1 ? 'Checked in {name} — 1 person.' : 'Checked in {name} — {n} people.',
    { name: `${rsvp.first_name} ${rsvp.last_name}`, n: guests });
});

module.exports = router;
