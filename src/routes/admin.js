const crypto = require('node:crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAdmin } = require('../middleware');
const svc = require('../services');
const { parseMoney, parseIntInRange, nowLocal, toCsv } = require('../util');

const router = express.Router();
router.use(requireAdmin);

const notFound = (res, what) => res.status(404).render('error', { title: 'Not found', message: `${what} not found.` });

router.get('/', (req, res) => {
  const { db } = req.app.locals;
  const today = nowLocal().slice(0, 10);
  const stats = {
    members: db.prepare('SELECT COUNT(*) AS n FROM users').get().n,
    activeMembers: db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM memberships WHERE end_date >= ?').get(today).n,
    upcomingEvents: db.prepare(`SELECT COUNT(*) AS n FROM events WHERE status = 'published' AND starts_at >= ?`).get(today).n,
    collected: db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS c FROM payments WHERE status = 'paid'`).get().c,
  };
  const events = db.prepare(`SELECT * FROM events WHERE status != 'cancelled' AND starts_at >= ? ORDER BY starts_at LIMIT 5`).all(today)
    .map((e) => ({ ...e, stats: svc.eventStats(db, e.id) }));
  const recentPayments = db.prepare(`SELECT p.*, u.first_name, u.last_name FROM payments p JOIN users u ON u.id = p.user_id
                                     WHERE p.status = 'paid' ORDER BY p.paid_at DESC LIMIT 8`).all();
  res.render('admin/dashboard', { title: 'Admin', stats, events, recentPayments });
});

// ---------- Members ----------

const MEMBER_LIST_SQL = `
  SELECT u.*, (SELECT MAX(end_date) FROM memberships m WHERE m.user_id = u.id) AS membership_end,
         (SELECT COUNT(*) FROM household_members h WHERE h.user_id = u.id) AS household_count
  FROM users u
  WHERE (? = '' OR u.first_name || ' ' || u.last_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ?
         OR u.city LIKE ? OR u.native_place LIKE ?)
  ORDER BY u.last_name COLLATE NOCASE, u.first_name COLLATE NOCASE
`;

function searchMembers(db, q) {
  const like = `%${q}%`;
  return db.prepare(MEMBER_LIST_SQL).all(q, like, like, like, like, like);
}

router.get('/members', (req, res) => {
  const q = String(req.query.q || '').trim();
  const members = searchMembers(req.app.locals.db, q);
  res.render('admin/members', { title: 'Members', members, q, today: nowLocal().slice(0, 10) });
});

router.get('/members.csv', (req, res) => {
  const { db } = req.app.locals;
  const members = searchMembers(db, '');
  const household = db.prepare('SELECT * FROM household_members ORDER BY user_id, id').all();
  const famBy = Map.groupBy(household, (h) => h.user_id);
  const rows = [['First name', 'Last name', 'Email', 'Phone', 'Address 1', 'Address 2', 'City', 'State', 'Postal code',
    'Native place', 'Date of birth', 'Occupation', 'Role', 'Membership valid until', 'Family members', 'Joined']];
  for (const m of members) {
    const fam = (famBy.get(m.id) || []).map((h) => `${h.name}${h.relationship ? ` (${h.relationship})` : ''}`).join('; ');
    rows.push([m.first_name, m.last_name, m.email, m.phone, m.address_line1, m.address_line2, m.city, m.state,
      m.postal_code, m.native_place, m.date_of_birth, m.occupation, m.role, m.membership_end, fam, m.created_at]);
  }
  res.attachment('members.csv').type('text/csv').send(toCsv(rows));
});

router.get('/members/:id', (req, res) => {
  const { db } = req.app.locals;
  const member = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!member) return notFound(res, 'Member');
  res.render('admin/member', {
    title: `${member.first_name} ${member.last_name}`,
    member,
    household: db.prepare('SELECT * FROM household_members WHERE user_id = ? ORDER BY id').all(member.id),
    membership: svc.membershipStatus(db, member.id),
    payments: db.prepare(`SELECT * FROM payments WHERE user_id = ? AND status = 'paid' ORDER BY paid_at DESC`).all(member.id),
    rsvps: db.prepare(`SELECT r.*, e.title, e.starts_at FROM rsvps r JOIN events e ON e.id = r.event_id
                       WHERE r.user_id = ? ORDER BY e.starts_at DESC`).all(member.id),
    plans: db.prepare('SELECT * FROM membership_plans ORDER BY active DESC, amount_cents').all(),
  });
});

router.post('/members/:id', (req, res) => {
  const { db } = req.app.locals;
  svc.updateProfile(db, req.params.id, req.body);
  db.prepare('UPDATE users SET notes = ? WHERE id = ?').run(String(req.body.notes || '').slice(0, 2000) || null, req.params.id);
  req.flash('success', 'Member profile saved.');
  res.redirect(`/admin/members/${req.params.id}`);
});

router.post('/members/:id/role', (req, res) => {
  const { db } = req.app.locals;
  const role = req.body.role === 'admin' ? 'admin' : 'member';
  if (Number(req.params.id) === req.user.id && role !== 'admin') throw new svc.UserError('You cannot remove your own admin access.');
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  req.flash('success', role === 'admin' ? 'Member is now an administrator.' : 'Admin access removed.');
  res.redirect(`/admin/members/${req.params.id}`);
});

router.post('/members/:id/reset-password', (req, res) => {
  const temp = crypto.randomBytes(6).toString('base64url');
  req.app.locals.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(temp, 10), req.params.id);
  req.app.locals.db.prepare(`DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?`).run(Number(req.params.id));
  req.flash('success', `Temporary password: ${temp} — share it with the member and ask them to change it.`);
  res.redirect(`/admin/members/${req.params.id}`);
});

// Record an offline (cash/check) payment: membership dues or a miscellaneous fee.
router.post('/members/:id/payments', (req, res) => {
  const { db } = req.app.locals;
  const member = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!member) return notFound(res, 'Member');
  const method = ['cash', 'check', 'other'].includes(req.body.method) ? req.body.method : 'cash';
  let payment;
  if (req.body.kind === 'membership') {
    const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ?').get(req.body.plan_id);
    if (!plan) throw new svc.UserError('Choose a membership plan.');
    const amount = req.body.amount ? parseMoney(req.body.amount) : plan.amount_cents;
    if (!(amount > 0)) throw new svc.UserError('Enter the amount received.');
    payment = svc.createPayment(db, { userId: member.id, kind: 'membership', referenceId: plan.id, amountCents: amount,
      description: `Membership — ${plan.name}` });
  } else {
    const amount = parseMoney(req.body.amount);
    const description = String(req.body.description || '').trim().slice(0, 200);
    if (!(amount > 0) || !description) throw new svc.UserError('Enter an amount and description.');
    payment = svc.createPayment(db, { userId: member.id, kind: 'other', amountCents: amount, description });
  }
  svc.markPaymentPaid(db, payment.id, { method, providerRef: String(req.body.reference || '').slice(0, 100) || null, recordedBy: req.user.id });
  req.flash('success', 'Payment recorded.');
  res.redirect(`/admin/members/${member.id}`);
});

// ---------- Events ----------

function parseEventForm(body) {
  const title = String(body.title || '').trim().slice(0, 200);
  const startsAt = String(body.starts_at || '');
  const fee = parseMoney(body.fee);
  const capacity = body.capacity ? parseIntInRange(body.capacity, 1, 100000) : null;
  const maxParty = parseIntInRange(body.max_party_size || 10, 1, 100);
  const dt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  if (!title) throw new svc.UserError('Event title is required.');
  if (!dt.test(startsAt)) throw new svc.UserError('Please choose a start date and time.');
  if (body.ends_at && !dt.test(body.ends_at)) throw new svc.UserError('End time is invalid.');
  if (body.rsvp_deadline && !dt.test(body.rsvp_deadline)) throw new svc.UserError('RSVP deadline is invalid.');
  if (Number.isNaN(fee)) throw new svc.UserError('Fee must be an amount like 15 or 15.50.');
  if (body.capacity && !capacity) throw new svc.UserError('Capacity must be a positive number.');
  if (!maxParty) throw new svc.UserError('Max people per RSVP must be between 1 and 100.');
  return {
    title,
    description: String(body.description || '').trim().slice(0, 5000) || null,
    location: String(body.location || '').trim().slice(0, 300) || null,
    starts_at: startsAt,
    ends_at: body.ends_at || null,
    rsvp_deadline: body.rsvp_deadline || null,
    fee_cents: fee,
    capacity,
    max_party_size: maxParty,
    members_only: body.members_only ? 1 : 0,
    status: ['draft', 'published', 'cancelled'].includes(body.status) ? body.status : 'published',
  };
}

router.get('/events', (req, res) => {
  const { db } = req.app.locals;
  const events = db.prepare('SELECT * FROM events ORDER BY starts_at DESC').all()
    .map((e) => ({ ...e, stats: svc.eventStats(db, e.id) }));
  res.render('admin/events', { title: 'Events', events, now: nowLocal() });
});

router.get('/events/new', (req, res) => {
  res.render('admin/event_form', { title: 'New event', event: { max_party_size: 10, status: 'published' } });
});

router.post('/events', (req, res) => {
  const e = parseEventForm(req.body);
  const id = req.app.locals.db.prepare(`
    INSERT INTO events (title, description, location, starts_at, ends_at, rsvp_deadline, fee_cents, capacity,
                        max_party_size, members_only, status, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(e.title, e.description, e.location, e.starts_at, e.ends_at, e.rsvp_deadline, e.fee_cents, e.capacity,
    e.max_party_size, e.members_only, e.status, req.user.id).lastInsertRowid;
  req.flash('success', 'Event created.');
  res.redirect(`/admin/events/${id}`);
});

router.get('/events/:id/edit', (req, res) => {
  const event = svc.getEvent(req.app.locals.db, req.params.id);
  if (!event) return notFound(res, 'Event');
  res.render('admin/event_form', { title: `Edit — ${event.title}`, event });
});

router.post('/events/:id', (req, res) => {
  const e = parseEventForm(req.body);
  req.app.locals.db.prepare(`
    UPDATE events SET title = ?, description = ?, location = ?, starts_at = ?, ends_at = ?, rsvp_deadline = ?,
      fee_cents = ?, capacity = ?, max_party_size = ?, members_only = ?, status = ? WHERE id = ?
  `).run(e.title, e.description, e.location, e.starts_at, e.ends_at, e.rsvp_deadline, e.fee_cents, e.capacity,
    e.max_party_size, e.members_only, e.status, req.params.id);
  req.flash('success', 'Event saved.');
  res.redirect(`/admin/events/${req.params.id}`);
});

function eventAttendees(db, eventId) {
  return db.prepare(`
    SELECT r.*, u.first_name, u.last_name, u.email, u.phone,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM payments p WHERE p.kind = 'event' AND p.reference_id = r.id AND p.status = 'paid') AS paid_cents
    FROM rsvps r JOIN users u ON u.id = r.user_id
    WHERE r.event_id = ?
    ORDER BY r.status = 'cancelled', u.last_name COLLATE NOCASE, u.first_name COLLATE NOCASE
  `).all(eventId);
}

router.get('/events/:id', (req, res) => {
  const { db } = req.app.locals;
  const event = svc.getEvent(db, req.params.id);
  if (!event) return notFound(res, 'Event');
  res.render('admin/event', {
    title: event.title, event,
    stats: svc.eventStats(db, event.id),
    revenue: svc.eventRevenue(db, event.id),
    attendees: eventAttendees(db, event.id),
  });
});

router.get('/events/:id/attendees.csv', (req, res) => {
  const { db, money } = req.app.locals;
  const event = svc.getEvent(db, req.params.id);
  if (!event) return notFound(res, 'Event');
  const rows = [['First name', 'Last name', 'Email', 'Phone', 'Status', 'People registered', 'Paid',
    'Checked in at', 'People checked in', 'RSVP date']];
  for (const a of eventAttendees(db, event.id)) {
    rows.push([a.first_name, a.last_name, a.email, a.phone, a.status, a.party_size, money(a.paid_cents),
      a.checked_in_at, a.checked_in_count, a.created_at]);
  }
  const slug = event.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event';
  res.attachment(`${slug}-attendees.csv`).type('text/csv').send(toCsv(rows));
});

// Collect an event fee in person (cash/check) — confirms the RSVP and issues the QR code.
router.post('/rsvps/:id/record-payment', (req, res) => {
  const { db } = req.app.locals;
  const rsvp = db.prepare('SELECT * FROM rsvps WHERE id = ?').get(req.params.id);
  if (!rsvp) return notFound(res, 'RSVP');
  const event = svc.getEvent(db, rsvp.event_id);
  const due = svc.amountDue(db, rsvp, event);
  if (due === 0) throw new svc.UserError('Nothing is owed for this RSVP.');
  const method = ['cash', 'check', 'other'].includes(req.body.method) ? req.body.method : 'cash';
  db.prepare(`UPDATE payments SET status = 'cancelled' WHERE kind = 'event' AND reference_id = ? AND status = 'pending'`).run(rsvp.id);
  const payment = svc.createPayment(db, { userId: rsvp.user_id, kind: 'event', referenceId: rsvp.id, amountCents: due,
    description: `${event.title} — ${rsvp.party_size} ${rsvp.party_size === 1 ? 'person' : 'people'}` });
  svc.markPaymentPaid(db, payment.id, { method, recordedBy: req.user.id });
  req.flash('success', `Recorded ${req.app.locals.money(due)} ${method} payment. RSVP confirmed.`);
  const back = String(req.body.return_to || '');
  res.redirect(back.startsWith('/admin/') ? back : `/admin/events/${rsvp.event_id}`);
});

// ---------- Check-in ----------

router.get('/checkin', (req, res) => {
  res.render('admin/checkin', { title: 'Check-in scanner' });
});

// Manual entry: accept either a bare token or a pasted ticket URL.
router.post('/checkin/lookup', (req, res) => {
  const raw = String(req.body.code || '').trim();
  const token = raw.split('/').filter(Boolean).pop() || '';
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) throw new svc.UserError('That does not look like a valid ticket code.');
  res.redirect(`/admin/checkin/${token}`);
});

router.get('/checkin/:token', (req, res) => {
  const { db } = req.app.locals;
  const rsvp = svc.findRsvpByToken(db, req.params.token);
  const due = rsvp ? svc.amountDue(db, rsvp, { fee_cents: rsvp.fee_cents }) : 0;
  // Distinguishes "you just checked them in" from "this code was already used earlier".
  const justCheckedIn = req.session.justCheckedIn === req.params.token;
  delete req.session.justCheckedIn;
  res.status(rsvp ? 200 : 404).render('admin/checkin_result', { title: 'Check-in', rsvp, due, justCheckedIn, token: req.params.token });
});

router.post('/checkin/:token', (req, res) => {
  const { db } = req.app.locals;
  const guests = parseIntInRange(req.body.guests, 1, 1000);
  let rsvp;
  try {
    rsvp = svc.checkIn(db, { token: req.params.token, guests, adminId: req.user.id });
  } catch (err) {
    if (!(err instanceof svc.UserError)) throw err;
    delete req.session.justCheckedIn;
    req.flash('error', err.message);
    return res.redirect(`/admin/checkin/${encodeURIComponent(req.params.token)}`);
  }
  req.session.justCheckedIn = req.params.token;
  req.flash('success', `Checked in ${rsvp.first_name} ${rsvp.last_name} — ${guests} ${guests === 1 ? 'person' : 'people'}.`);
  res.redirect(`/admin/checkin/${encodeURIComponent(req.params.token)}`);
});

// ---------- Payments & plans ----------

router.get('/payments', (req, res) => {
  const { db } = req.app.locals;
  const kind = ['membership', 'event', 'other'].includes(req.query.kind) ? req.query.kind : '';
  const payments = db.prepare(`
    SELECT p.*, u.first_name, u.last_name, u.email FROM payments p JOIN users u ON u.id = p.user_id
    WHERE p.status = 'paid' AND (? = '' OR p.kind = ?) ORDER BY p.paid_at DESC LIMIT 500
  `).all(kind, kind);
  const total = payments.reduce((sum, p) => sum + p.amount_cents, 0);
  res.render('admin/payments', { title: 'Payments', payments, total, kind });
});

router.get('/payments.csv', (req, res) => {
  const { db, money } = req.app.locals;
  const rows = [['Date', 'First name', 'Last name', 'Email', 'Type', 'Description', 'Amount', 'Method', 'Reference']];
  for (const p of db.prepare(`SELECT p.*, u.first_name, u.last_name, u.email FROM payments p JOIN users u ON u.id = p.user_id
                              WHERE p.status = 'paid' ORDER BY p.paid_at DESC`).all()) {
    rows.push([p.paid_at, p.first_name, p.last_name, p.email, p.kind, p.description, money(p.amount_cents), p.method, p.provider_ref]);
  }
  res.attachment('payments.csv').type('text/csv').send(toCsv(rows));
});

router.get('/plans', (req, res) => {
  const plans = req.app.locals.db.prepare('SELECT * FROM membership_plans ORDER BY active DESC, amount_cents').all();
  res.render('admin/plans', { title: 'Membership plans', plans });
});

router.post('/plans', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const amount = parseMoney(req.body.amount);
  const months = parseIntInRange(req.body.duration_months, 1, 1200);
  if (!name || Number.isNaN(amount) || !months) throw new svc.UserError('Enter a name, amount and duration for the plan.');
  req.app.locals.db.prepare('INSERT INTO membership_plans (name, description, amount_cents, duration_months) VALUES (?, ?, ?, ?)')
    .run(name, String(req.body.description || '').trim().slice(0, 500) || null, amount, months);
  req.flash('success', 'Plan added.');
  res.redirect('/admin/plans');
});

router.post('/plans/:id/toggle', (req, res) => {
  req.app.locals.db.prepare('UPDATE membership_plans SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/admin/plans');
});

module.exports = router;
