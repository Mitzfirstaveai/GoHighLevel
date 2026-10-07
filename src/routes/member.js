const express = require('express');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { requireAuth } = require('../middleware');
const svc = require('../services');
const { parseIntInRange, nowLocal } = require('../util');
const { receiptNumber } = require('./donations');

const router = express.Router();

function ticketUrl(config, token) {
  // The QR encodes the admin check-in URL, so any phone camera can open it too.
  return `${config.baseUrl}/admin/checkin/${token}`;
}

router.get('/dashboard', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const membership = svc.membershipStatus(db, req.user.id);
  const myRsvps = db.prepare(`
    SELECT r.*, e.title, e.starts_at, e.location, e.fee_cents FROM rsvps r
    JOIN events e ON e.id = r.event_id
    WHERE r.user_id = ? AND r.status != 'cancelled' AND e.starts_at >= ?
    ORDER BY e.starts_at
  `).all(req.user.id, nowLocal().slice(0, 10));
  const latestNews = db.prepare('SELECT * FROM news_posts ORDER BY created_at DESC, id DESC LIMIT 1').get();
  const upcoming = db.prepare(`
    SELECT * FROM events WHERE status = 'published' AND starts_at >= ?
    AND id NOT IN (SELECT event_id FROM rsvps WHERE user_id = ? AND status != 'cancelled')
    ORDER BY starts_at LIMIT 5
  `).all(nowLocal(), req.user.id);
  res.render('member/dashboard', { title: 'My dashboard', membership, myRsvps, upcoming, latestNews });
});

// ---------- Profile ----------

router.get('/profile', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const membership = svc.membershipStatus(db, req.user.id);
  res.render('member/profile', {
    title: 'My profile', profile: req.user, household: svc.getHousehold(db, req.user.id), membership,
    coverage: membership.active && membership.plan ? svc.planCoverage(membership.plan) : null,
    relationships: Object.keys(svc.RELATIONSHIPS),
  });
});

router.post('/profile', requireAuth, (req, res) => {
  svc.updateProfile(req.app.locals.db, req.user.id, req.body);
  req.flash('success', 'Profile saved.');
  res.redirect('/profile');
});

router.post('/profile/household', requireAuth, (req, res) => {
  const birthYear = req.body.birth_year ? parseIntInRange(req.body.birth_year, 1900, new Date().getFullYear()) : null;
  if (req.body.birth_year && !birthYear) throw new svc.UserError('Birth year looks incorrect.');
  const { name } = svc.addHouseholdMember(req.app.locals.db, {
    userId: req.user.id, name: req.body.name, relationship: req.body.relationship, birthYear,
  });
  req.flash('success', `${name} added to your family.`);
  res.redirect('/profile#family');
});

router.post('/profile/household/:id/delete', requireAuth, (req, res) => {
  req.app.locals.db.prepare('DELETE FROM household_members WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.redirect('/profile#family');
});

router.post('/profile/password', requireAuth, (req, res) => {
  const { current_password: current, new_password: next, new_password_confirm: confirm } = req.body;
  if (!req.user.password_hash || !bcrypt.compareSync(String(current || ''), req.user.password_hash)) throw new svc.UserError('Current password is incorrect.');
  if (String(next || '').length < 8) throw new svc.UserError('New password must be at least 8 characters.');
  if (next !== confirm) throw new svc.UserError('New passwords do not match.');
  req.app.locals.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), req.user.id);
  req.flash('success', 'Password changed.');
  res.redirect('/profile');
});

router.post('/profile/privacy', requireAuth, (req, res) => {
  const listed = req.body.directory_listed ? 1 : 0;
  req.app.locals.db.prepare('UPDATE users SET directory_listed = ?, directory_contact = ? WHERE id = ?')
    .run(listed, listed && req.body.directory_contact ? 1 : 0, req.user.id);
  req.flash('success', 'Directory settings saved.');
  res.redirect('/profile#privacy');
});

// ---------- Community ----------

router.get('/directory', requireAuth, (req, res) => {
  const q = String(req.query.q || '').trim();
  const like = `%${q}%`;
  const members = req.app.locals.db.prepare(`
    SELECT id, first_name, last_name, city, native_place, directory_contact, phone, email FROM users
    WHERE directory_listed = 1
      AND (password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id))
      AND (? = '' OR first_name || ' ' || last_name LIKE ? OR city LIKE ? OR native_place LIKE ?)
    ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE
  `).all(q, like, like, like);
  res.render('member/directory', { title: 'Member directory', members, q });
});

router.get('/news', requireAuth, (req, res) => {
  const posts = req.app.locals.db.prepare(`SELECT n.*, u.first_name, u.last_name FROM news_posts n
    LEFT JOIN users u ON u.id = n.author_id ORDER BY n.created_at DESC, n.id DESC`).all();
  res.render('member/news', { title: 'News', posts });
});

// Phone "More" tab: everything that doesn't fit in the bottom bar.
router.get('/more', requireAuth, (req, res) => res.render('member/more', { title: 'More' }));

// ---------- Events ----------

router.get('/events', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  if (req.query.view === 'calendar') return renderCalendar(req, res);
  const events = db.prepare(`
    SELECT e.*, r.status AS my_status, r.party_size AS my_party FROM events e
    LEFT JOIN rsvps r ON r.event_id = e.id AND r.user_id = ? AND r.status != 'cancelled'
    WHERE e.status != 'draft' AND e.starts_at >= ? ORDER BY e.starts_at
  `).all(req.user.id, nowLocal().slice(0, 10));
  const past = db.prepare(`SELECT id, title, starts_at FROM events WHERE status = 'published' AND starts_at < ?
                           ORDER BY starts_at DESC LIMIT 20`).all(nowLocal().slice(0, 10));
  res.render('member/events', { title: 'Events', events, past });
});

// Month grid of events (?view=calendar&month=YYYY-MM).
function renderCalendar(req, res) {
  const { db } = req.app.locals;
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : nowLocal().slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const events = db.prepare(`SELECT e.id, e.title, e.starts_at, e.status, r.status AS my_status FROM events e
    LEFT JOIN rsvps r ON r.event_id = e.id AND r.user_id = ? AND r.status != 'cancelled'
    WHERE e.status != 'draft' AND substr(e.starts_at, 1, 7) = ? ORDER BY e.starts_at`).all(req.user.id, month);
  const byDay = Map.groupBy(events, (e) => Number(e.starts_at.slice(8, 10)));
  const shift = (delta) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return d.toISOString().slice(0, 7);
  };
  res.render('member/calendar', {
    title: 'Events calendar', month, byDay, daysInMonth, leadingBlanks: first.getUTCDay(),
    monthLabel: first.toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    prev: shift(-1), next: shift(1), todayKey: nowLocal().slice(0, 10),
  });
}

// "Add to my calendar" file (works with iPhone, Google and Outlook calendars).
router.get('/events/:id/calendar.ics', requireAuth, (req, res) => {
  const event = svc.getEvent(req.app.locals.db, req.params.id);
  if (!event || event.status === 'draft') return res.sendStatus(404);
  const stamp = (local) => local.replace(/[-:]/g, '') + '00';
  const end = event.ends_at || event.starts_at.replace(/T(\d{2})/, (_, h) => `T${String(Math.min(23, Number(h) + 2)).padStart(2, '0')}`);
  const esc = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
  const { config } = req.app.locals;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${esc(res.locals.org.shortName)}//Events//EN`, 'BEGIN:VEVENT',
    `UID:event-${event.id}@${new URL(config.baseUrl).host}`,
    `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
    `DTSTART:${stamp(event.starts_at)}`, `DTEND:${stamp(end)}`,
    `SUMMARY:${esc(event.title)}`, `LOCATION:${esc(event.location)}`,
    `DESCRIPTION:${esc(`${event.description || ''}\n${config.baseUrl}/events/${event.id}`)}`,
    'END:VEVENT', 'END:VCALENDAR',
  ];
  res.type('text/calendar').attachment(`${event.title.replace(/[^\w]+/g, '-')}.ics`).send(lines.join('\r\n') + '\r\n');
});

router.get('/events/:id', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const event = svc.getEvent(db, req.params.id);
  if (!event || event.status === 'draft') return res.status(404).render('error', { title: 'Not found', message: 'Event not found.' });
  const rsvp = db.prepare(`SELECT * FROM rsvps WHERE event_id = ? AND user_id = ? AND status != 'cancelled'`)
    .get(event.id, req.user.id);
  const membership = svc.membershipStatus(db, req.user.id);
  const memberPrice = svc.memberPrice(event);
  const guestPrice = event.guest_fee_cents ?? event.fee_cents;
  res.render('member/event', {
    title: event.title, event, rsvp, membership, open: svc.rsvpWindowOpen(event),
    due: rsvp ? svc.amountDue(db, rsvp) : 0,
    maxParty: svc.maxPartySize(db, event, req.user.id),
    familyListed: svc.getHousehold(db, req.user.id).length,
    spotsLeft: event.capacity ? Math.max(0, event.capacity - svc.reservedSeats(db, event.id)) : null,
    questions: svc.eventQuestions(event),
    answers: rsvp ? JSON.parse(rsvp.answers || '[]') : [],
    earlyBird: svc.earlyBirdActive(event),
    prices: { self: membership.active ? memberPrice : guestPrice, member: memberPrice, guest: event.guest_fee_cents ?? 0 },
  });
});

router.post('/events/:id/rsvp', requireAuth, async (req, res) => {
  const { db, gateway } = req.app.locals;
  const { rsvp, amountDue, qrReplaced, waitlisted } = svc.upsertRsvp(db, {
    eventId: Number(req.params.id), userId: req.user.id,
    partySize: parseIntInRange(req.body.party_size, 1, 1000),
    guests: req.body.guests ? parseIntInRange(req.body.guests, 0, 1000) ?? -1 : 0,
    couponCode: String(req.body.coupon || '').trim(),
    body: req.body,
    joinWaitlist: Boolean(req.body.waitlist),
  });
  if (waitlisted) {
    req.flash('info', `The event is full, so you're on the waitlist for ${rsvp.party_size} ${rsvp.party_size === 1 ? 'person' : 'people'}. If seats open up you'll be moved in automatically${rsvp.total_cents ? ' and can then pay' : ''}.`);
    return res.redirect(`/events/${req.params.id}`);
  }
  if (qrReplaced) {
    req.flash('info', `Your RSVP is now for ${rsvp.party_size} ${rsvp.party_size === 1 ? 'person' : 'people'}. A new QR code was issued — your old QR code no longer works.`);
  }
  if (rsvp.discount_cents) req.flash('success', `Coupon ${rsvp.coupon_code} applied: ${req.app.locals.money(rsvp.discount_cents)} off.`);
  if (amountDue === 0) {
    if (!qrReplaced) req.flash('success', 'You are registered! Show this QR code at the entrance.');
    return res.redirect(`/tickets/${rsvp.id}`);
  }
  const payment = svc.createEventPayment(db, { rsvpId: rsvp.id, userId: req.user.id });
  const url = await gateway.startCheckout(payment, req.user);
  if (!url) {
    req.flash('info', 'Your RSVP is saved. Online payment is not available yet — please pay an organizer to receive your QR code.');
    return res.redirect(`/events/${req.params.id}`);
  }
  res.redirect(303, url);
});

router.post('/events/:id/pay', requireAuth, async (req, res) => {
  const { db, gateway } = req.app.locals;
  const rsvp = db.prepare(`SELECT * FROM rsvps WHERE event_id = ? AND user_id = ?`).get(req.params.id, req.user.id);
  if (!rsvp) throw new svc.UserError('Please RSVP first.');
  const payment = svc.createEventPayment(db, { rsvpId: rsvp.id, userId: req.user.id });
  const url = await gateway.startCheckout(payment, req.user);
  if (!url) throw new svc.UserError('Online payment is not available. Please pay an organizer.');
  res.redirect(303, url);
});

router.post('/events/:id/cancel', requireAuth, (req, res) => {
  svc.cancelRsvp(req.app.locals.db, { eventId: Number(req.params.id), userId: req.user.id });
  req.flash('success', 'Your RSVP was cancelled.');
  res.redirect(`/events/${req.params.id}`);
});

// ---------- Tickets (QR codes) ----------

function loadTicket(req) {
  const rsvp = req.app.locals.db.prepare(`
    SELECT r.*, e.title, e.starts_at, e.location FROM rsvps r JOIN events e ON e.id = r.event_id
    WHERE r.id = ?
  `).get(req.params.id);
  // Members see their own tickets; admins can view anyone's (e.g. to resend).
  if (!rsvp || (rsvp.user_id !== req.user.id && req.user.role !== 'admin')) return null;
  return rsvp;
}

router.get('/tickets', requireAuth, (req, res) => {
  const tickets = req.app.locals.db.prepare(`
    SELECT r.*, e.title, e.starts_at, e.location FROM rsvps r JOIN events e ON e.id = r.event_id
    WHERE r.user_id = ? AND r.status != 'cancelled' AND e.starts_at >= ? ORDER BY e.starts_at
  `).all(req.user.id, nowLocal().slice(0, 10));
  res.render('member/tickets', { title: 'My tickets', tickets });
});

router.get('/tickets/:id', requireAuth, async (req, res) => {
  const rsvp = loadTicket(req);
  if (!rsvp) return res.status(404).render('error', { title: 'Not found', message: 'Ticket not found.' });
  const qrDataUrl = rsvp.status === 'confirmed'
    ? await QRCode.toDataURL(ticketUrl(req.app.locals.config, rsvp.qr_token), { width: 320, margin: 2 })
    : null;
  res.render('member/ticket', { title: `Ticket — ${rsvp.title}`, rsvp, qrDataUrl });
});

router.get('/tickets/:id/qr.png', requireAuth, async (req, res) => {
  const rsvp = loadTicket(req);
  if (!rsvp || rsvp.status !== 'confirmed') return res.sendStatus(404);
  res.type('png');
  res.set('Content-Disposition', `inline; filename="ticket-${rsvp.id}.png"`);
  res.send(await QRCode.toBuffer(ticketUrl(req.app.locals.config, rsvp.qr_token), { width: 600, margin: 2 }));
});

// ---------- Membership & payments ----------

router.get('/membership', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const membership = svc.membershipStatus(db, req.user.id);
  res.render('member/membership', {
    title: 'Membership',
    membership,
    coverage: membership.plan ? svc.planCoverage(membership.plan) : null,
    history: db.prepare(`SELECT m.*, p.name AS plan_name FROM memberships m LEFT JOIN membership_plans p ON p.id = m.plan_id
                         WHERE m.user_id = ? ORDER BY m.end_date DESC, m.id DESC`).all(req.user.id),
    plans: db.prepare('SELECT * FROM membership_plans WHERE active = 1 ORDER BY sort_order, amount_cents').all().map((plan) => ({
      ...plan,
      coverage: svc.planCoverage(plan),
      quote: svc.membershipQuote(db, plan, req.user.id),
      blocked: svc.planIneligibility(db, plan, req.user),
    })),
  });
});

router.post('/membership/pay', requireAuth, async (req, res) => {
  const { db, gateway } = req.app.locals;
  const payment = svc.createMembershipPayment(db, { planId: Number(req.body.plan_id), user: req.user });
  if (!payment) {
    req.flash('success', 'Your membership is active.');
    return res.redirect('/membership');
  }
  const url = await gateway.startCheckout(payment, req.user);
  if (!url) throw new svc.UserError('Online payment is not available yet. Please pay an organizer.');
  res.redirect(303, url);
});

// Printable receipt for any paid payment (members see their own; admins see all).
router.get('/receipts/:id', requireAuth, (req, res) => {
  const payment = req.app.locals.db.prepare(`SELECT p.*, u.first_name, u.last_name, u.email, u.address_line1, u.address_line2,
      u.city, u.state, u.postal_code, c.title AS campaign_title
    FROM payments p JOIN users u ON u.id = p.user_id LEFT JOIN campaigns c ON p.kind = 'donation' AND c.id = p.reference_id
    WHERE p.id = ? AND p.status = 'paid'`).get(req.params.id);
  if (!payment || (payment.user_id !== req.user.id && req.user.role !== 'admin')) {
    return res.status(404).render('error', { title: 'Not found', message: 'Receipt not found.' });
  }
  res.render('member/receipt', { title: `Receipt ${receiptNumber(payment.id)}`, payment, number: receiptNumber(payment.id) });
});

router.get('/payments', requireAuth, (req, res) => {
  const payments = req.app.locals.db.prepare(`SELECT * FROM payments WHERE user_id = ? AND status = 'paid' ORDER BY paid_at DESC`)
    .all(req.user.id);
  res.render('member/payments', { title: 'My payments', payments });
});

module.exports = router;
