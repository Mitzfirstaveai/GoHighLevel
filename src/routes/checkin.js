// Door check-in, shared by administrators and door volunteers (members an admin has given
// check-in access, signed in at /admin/login). Volunteers see only these pages: the scanner,
// a name search for the day's events and the ticket result — no contact details, payments
// or other admin pages.
// Mounted at /admin/checkin because members' QR codes link to /admin/checkin/<code>.
const express = require('express');
const { requireCheckin, canCheckIn } = require('../middleware');
const svc = require('../services');
const { parseIntInRange, nowLocal } = require('../util');

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
    ? db.prepare(`SELECT id, first_name, last_name FROM users WHERE checkin_access = 1 AND role != 'admin' ORDER BY first_name, last_name`).all()
    : [];
  res.render('admin/checkin', { title: 'Door check-in', events, selected, q, results, volunteers });
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

router.get('/:token', (req, res) => {
  const { db } = req.app.locals;
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
  res.status(rsvp ? 200 : 404).render('admin/checkin_result', {
    title: 'Check-in', rsvp, retired, due, paid, justCheckedIn, notToday, token: req.params.token,
    names: rsvp ? svc.attendeeNames(db, rsvp) : [],
    eventTitle: rsvp ? (req.lang === 'gu' && event.title_gu) || rsvp.event_title : '',
  });
});

// Money collected at the door (cash, check or other) for a family that still owes.
router.post('/:token/payment', (req, res) => {
  const { db } = req.app.locals;
  const rsvp = svc.findRsvpByToken(db, req.params.token);
  if (!rsvp) throw new svc.UserError('This QR code is not valid.');
  const method = ['cash', 'check', 'other'].includes(req.body.method) ? req.body.method : 'cash';
  const { due } = svc.recordRsvpPayment(db, { rsvpId: rsvp.id, method, recordedBy: req.user.id });
  req.flash('success', 'Recorded {amount} paid by {method}. Now check them in.', { amount: req.app.locals.money(due), method: req.t({ cash: 'cash', check: 'check', other: 'other' }[method]) });
  res.redirect(`/admin/checkin/${req.params.token}`);
});

router.post('/:token', (req, res) => {
  const { db } = req.app.locals;
  const guests = parseIntInRange(req.body.guests, 1, 1000);
  const back = `/admin/checkin/${encodeURIComponent(req.params.token)}`;
  let rsvp;
  try {
    rsvp = svc.checkIn(db, { token: req.params.token, guests, adminId: req.user.id });
  } catch (err) {
    if (!(err instanceof svc.UserError)) throw err;
    delete req.session.justCheckedIn;
    req.flash('error', err.template, err.vars);
    return res.redirect(back);
  }
  req.session.justCheckedIn = req.params.token;
  req.flash('success', guests === 1 ? 'Checked in {name} — 1 person.' : 'Checked in {name} — {n} people.',
    { name: `${rsvp.first_name} ${rsvp.last_name}`, n: guests });
  res.redirect(back);
});

module.exports = router;
