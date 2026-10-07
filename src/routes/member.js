const express = require('express');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { requireAuth } = require('../middleware');
const svc = require('../services');
const { parseIntInRange, nowLocal } = require('../util');

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
  const upcoming = db.prepare(`
    SELECT * FROM events WHERE status = 'published' AND starts_at >= ?
    AND id NOT IN (SELECT event_id FROM rsvps WHERE user_id = ? AND status != 'cancelled')
    ORDER BY starts_at LIMIT 5
  `).all(nowLocal(), req.user.id);
  res.render('member/dashboard', { title: 'My dashboard', membership, myRsvps, upcoming });
});

// ---------- Profile ----------

router.get('/profile', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const household = db.prepare('SELECT * FROM household_members WHERE user_id = ? ORDER BY id').all(req.user.id);
  res.render('member/profile', { title: 'My profile', profile: req.user, household });
});

router.post('/profile', requireAuth, (req, res) => {
  svc.updateProfile(req.app.locals.db, req.user.id, req.body);
  req.flash('success', 'Profile saved.');
  res.redirect('/profile');
});

router.post('/profile/household', requireAuth, (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 120);
  if (!name) throw new svc.UserError('Please enter a name for the family member.');
  const birthYear = req.body.birth_year ? parseIntInRange(req.body.birth_year, 1900, new Date().getFullYear()) : null;
  if (req.body.birth_year && !birthYear) throw new svc.UserError('Birth year looks incorrect.');
  req.app.locals.db.prepare('INSERT INTO household_members (user_id, name, relationship, birth_year) VALUES (?, ?, ?, ?)')
    .run(req.user.id, name, String(req.body.relationship || '').trim().slice(0, 60) || null, birthYear);
  req.flash('success', `${name} added to your family.`);
  res.redirect('/profile#family');
});

router.post('/profile/household/:id/delete', requireAuth, (req, res) => {
  req.app.locals.db.prepare('DELETE FROM household_members WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.redirect('/profile#family');
});

router.post('/profile/password', requireAuth, (req, res) => {
  const { current_password: current, new_password: next, new_password_confirm: confirm } = req.body;
  if (!bcrypt.compareSync(String(current || ''), req.user.password_hash)) throw new svc.UserError('Current password is incorrect.');
  if (String(next || '').length < 8) throw new svc.UserError('New password must be at least 8 characters.');
  if (next !== confirm) throw new svc.UserError('New passwords do not match.');
  req.app.locals.db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), req.user.id);
  req.flash('success', 'Password changed.');
  res.redirect('/profile');
});

// ---------- Events ----------

router.get('/events', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const events = db.prepare(`
    SELECT e.*, r.status AS my_status, r.party_size AS my_party FROM events e
    LEFT JOIN rsvps r ON r.event_id = e.id AND r.user_id = ? AND r.status != 'cancelled'
    WHERE e.status != 'draft' AND e.starts_at >= ? ORDER BY e.starts_at
  `).all(req.user.id, nowLocal().slice(0, 10));
  res.render('member/events', { title: 'Events', events });
});

router.get('/events/:id', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const event = svc.getEvent(db, req.params.id);
  if (!event || event.status === 'draft') return res.status(404).render('error', { title: 'Not found', message: 'Event not found.' });
  const rsvp = db.prepare(`SELECT * FROM rsvps WHERE event_id = ? AND user_id = ? AND status != 'cancelled'`)
    .get(event.id, req.user.id);
  const due = rsvp ? svc.amountDue(db, rsvp, event) : 0;
  const spotsLeft = event.capacity ? Math.max(0, event.capacity - svc.reservedSeats(db, event.id)) : null;
  const membership = svc.membershipStatus(db, req.user.id);
  res.render('member/event', {
    title: event.title, event, rsvp, due, spotsLeft, membership, open: svc.rsvpWindowOpen(event),
  });
});

router.post('/events/:id/rsvp', requireAuth, async (req, res) => {
  const { db, gateway } = req.app.locals;
  const partySize = parseIntInRange(req.body.party_size, 1, 1000);
  const { rsvp, amountDue } = svc.upsertRsvp(db, { eventId: Number(req.params.id), userId: req.user.id, partySize });
  if (amountDue === 0) {
    req.flash('success', 'You are registered! Show this QR code at the entrance.');
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
  const { refundableCents } = svc.cancelRsvp(req.app.locals.db, { eventId: Number(req.params.id), userId: req.user.id });
  req.flash('success', refundableCents > 0
    ? `Your RSVP was cancelled. An organizer will contact you about your ${req.app.locals.money(refundableCents)} payment.`
    : 'Your RSVP was cancelled.');
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
  res.render('member/membership', {
    title: 'Membership',
    membership: svc.membershipStatus(db, req.user.id),
    history: db.prepare(`SELECT m.*, p.name AS plan_name FROM memberships m LEFT JOIN membership_plans p ON p.id = m.plan_id
                         WHERE m.user_id = ? ORDER BY m.end_date DESC`).all(req.user.id),
    plans: db.prepare('SELECT * FROM membership_plans WHERE active = 1 ORDER BY amount_cents').all(),
  });
});

router.post('/membership/pay', requireAuth, async (req, res) => {
  const { db, gateway } = req.app.locals;
  const payment = svc.createMembershipPayment(db, { planId: Number(req.body.plan_id), userId: req.user.id });
  if (!payment) {
    req.flash('success', 'Your membership is active.');
    return res.redirect('/membership');
  }
  const url = await gateway.startCheckout(payment, req.user);
  if (!url) throw new svc.UserError('Online payment is not available yet. Please pay an organizer.');
  res.redirect(303, url);
});

router.get('/payments', requireAuth, (req, res) => {
  const payments = req.app.locals.db.prepare(`SELECT * FROM payments WHERE user_id = ? AND status = 'paid' ORDER BY paid_at DESC`)
    .all(req.user.id);
  res.render('member/payments', { title: 'My payments', payments });
});

module.exports = router;
