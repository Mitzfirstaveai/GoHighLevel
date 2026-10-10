const express = require('express');
const bcrypt = require('bcryptjs');
const { passwordProblem, hashPassword, minLength } = require('../passwords');
const QRCode = require('qrcode');
const { requireAuth } = require('../middleware');
const svc = require('../services');
const { parseIntInRange, nowLocal, today, weekdayName } = require('../util');
const { receiptNumber } = require('./donations');
const newsfeed = require('../newsfeed');

const router = express.Router();

function ticketUrl(config, token) {
  // The QR encodes the admin check-in URL, so any phone camera can open it too.
  return `${config.baseUrl}/admin/checkin/${token}`;
}

// Upcoming tickets for the whole family (the member and any family logins), soonest first,
// each with the names it's for.
function familyTickets(db, userId) {
  const ids = svc.familyUserIds(db, userId);
  return db.prepare(`
    SELECT r.*, e.title, e.title_gu, e.starts_at, e.location, e.fee_cents, u.first_name AS holder_first, u.last_name AS holder_last
    FROM rsvps r JOIN events e ON e.id = r.event_id JOIN users u ON u.id = r.user_id
    WHERE r.user_id IN (${ids.map(() => '?').join(',')}) AND r.status != 'cancelled' AND e.starts_at >= ?
    ORDER BY e.starts_at, r.user_id != ?
  `).all(...ids, nowLocal().slice(0, 10), userId).map((r) => ({ ...r, names: svc.attendeeNames(db, r), mine: r.user_id === userId, due: svc.amountDue(db, r) }));
}

router.get('/dashboard', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const membership = svc.membershipStatus(db, req.user.id);
  const myRsvps = familyTickets(db, req.user.id);
  const latestNews = db.prepare('SELECT * FROM news_posts ORDER BY created_at DESC, id DESC LIMIT 1').get();
  const headlines = newsfeed.mixedHeadlines(db, { lang: defaultNewsLang(req), limit: 5 });
  // "Your next event" tile: the soonest ticket (the member's own first), and how many other events follow.
  const nextTicket = myRsvps[0] || null;
  const moreEvents = new Set(myRsvps.map((r) => r.event_id).filter((id) => id !== nextTicket?.event_id)).size;
  const nextIsToday = Boolean(nextTicket && nextTicket.starts_at.slice(0, 10) === today());
  // Family logins: the membership is held (and renewed) by the member who added them.
  const holder = req.user.owner_id ? db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(req.user.owner_id) : null;
  // "Renew for 2027" on the Membership tile, once next year's dues can be paid (at most a year ahead).
  const canRenew = membership.active && !holder && membership.validUntil && !svc.renewalOpensOn(db, req.user.id);
  const renewYear = canRenew && membership.plan?.calendar_year ? Number(membership.validUntil.slice(0, 4)) + 1 : null;
  const upcoming = db.prepare(`
    SELECT * FROM events WHERE status = 'published' AND starts_at >= ?
    AND id NOT IN (SELECT event_id FROM rsvps WHERE user_id = ? AND status != 'cancelled')
    ORDER BY starts_at LIMIT 5
  `).all(nowLocal(), req.user.id);
  res.render('member/dashboard', {
    // Members who signed up before these were required (or were imported) are asked to complete their profile.
    missingProfile: svc.missingProfile(req.user),
    missingBirths: req.user.owner_id ? [] : svc.getHousehold(db, req.user.id).filter((h) => !svc.birthLocked(h)).map((h) => h.name),
    eventNews: svc.eventAnnouncements(db, req.user.id),
    title: 'My dashboard', membership, nextTicket, moreEvents, nextIsToday, upcoming, latestNews, headlines, holder, canRenew, renewYear, celebrations: celebrationList(req, res),
  });
});

// ---------- Profile ----------

router.get('/profile', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const membership = svc.membershipStatus(db, req.user.id);
  // A family login sees the family it belongs to (managed by the member who listed them).
  const owner = req.user.owner_id ? db.prepare('SELECT id, first_name, last_name FROM users WHERE id = ?').get(req.user.owner_id) : null;
  res.render('member/profile', {
    passwordMin: minLength(req.user),
    title: 'My profile', profile: req.user, household: svc.getHousehold(db, owner?.id ?? req.user.id), membership, owner,
    baseUrl: req.app.locals.config.baseUrl, today: today(), now: db.prepare(`SELECT datetime('now') AS n`).get().n,
    coverageParts: membership.active && membership.plan ? svc.planCoverageParts(membership.plan) : null,
    relationships: Object.keys(svc.RELATIONSHIPS),
  });
});

router.post('/profile', requireAuth, (req, res) => {
  svc.updateProfile(req.app.locals.db, req.user.id, req.body, { complete: true });
  req.flash('success', 'Profile saved.');
  res.redirect('/profile');
});

// Only the member who holds the membership manages the family list.
function requireFamilyManager(req, res, next) {
  if (req.user.owner_id) throw new svc.UserError('Your family list is managed by the member who added you. Please ask them to make changes.');
  next();
}

const birthFields = (body) => {
  const birthYear = body.birth_year ? parseIntInRange(body.birth_year, 1900, new Date().getFullYear()) : null;
  if (body.birth_year && !birthYear) throw new svc.UserError('Birth year looks incorrect.');
  const birthMonth = body.birth_month ? parseIntInRange(body.birth_month, 1, 12) : null;
  const birthDay = body.birth_day ? parseIntInRange(body.birth_day, 1, 31) : null;
  return { birthYear, birthMonth, birthDay };
};

router.post('/profile/household', requireAuth, requireFamilyManager, (req, res) => {
  const { name } = svc.addHouseholdMember(req.app.locals.db, {
    userId: req.user.id, name: req.body.name, relationship: req.body.relationship, ...birthFields(req.body),
  });
  req.flash('success', '{name} added to your family.', { name });
  res.redirect('/profile#family');
});

// Birth date for a family member added without one (or without the day): can be filled in once, then locked.
router.post('/profile/household/:id/birth', requireAuth, requireFamilyManager, (req, res) => {
  const h = svc.setHouseholdBirth(req.app.locals.db, { ownerId: req.user.id, householdId: Number(req.params.id), ...birthFields(req.body) });
  req.flash('success', 'Birth date saved for {name}.', { name: h.name });
  res.redirect('/profile#family');
});

router.post('/profile/household/:id/delete', requireAuth, requireFamilyManager, (req, res) => {
  svc.removeHouseholdMember(req.app.locals.db, { ownerId: req.user.id, householdId: Number(req.params.id) });
  res.redirect('/profile#family');
});

// Give a family member their own login: a private, single-use invite link the member shares.
router.post('/profile/household/:id/invite', requireAuth, requireFamilyManager, (req, res) => {
  const { name } = svc.createFamilyInvite(req.app.locals.db, { ownerId: req.user.id, householdId: Number(req.params.id) });
  req.flash('success', 'Invite link for {name} is ready. Share it with them — it works once and expires in 14 days.', { name });
  res.redirect(`/profile#invite-${req.params.id}`);
});

router.post('/profile/household/:id/invite/cancel', requireAuth, requireFamilyManager, (req, res) => {
  svc.cancelFamilyInvite(req.app.locals.db, { ownerId: req.user.id, householdId: Number(req.params.id) });
  req.flash('success', 'Invite link cancelled.');
  res.redirect('/profile#family');
});

router.post('/profile/password', requireAuth, (req, res) => {
  const { current_password: current, new_password: next, new_password_confirm: confirm } = req.body;
  if (!req.user.password_hash || !bcrypt.compareSync(String(current || ''), req.user.password_hash)) throw new svc.UserError('Current password is incorrect.');
  const problem = passwordProblem(next, req.user);
  if (problem) throw new svc.UserError(problem.message, problem.vars);
  if (next !== confirm) throw new svc.UserError('New passwords do not match.');
  req.app.locals.db.prepare('UPDATE users SET password_hash = ?, password_temporary = 0 WHERE id = ?').run(hashPassword(next), req.user.id);
  req.flash('success', 'Password changed.');
  res.redirect('/profile');
});

router.post('/profile/celebrations', requireAuth, (req, res) => {
  svc.updateCelebrations(req.app.locals.db, req.user.id, req.body);
  req.flash('success', 'Celebration settings saved.');
  res.redirect('/profile#celebrations');
});

// Shared birthdays and anniversaries this week, with "Today", "Tomorrow" or the day and date.
function celebrationList(req, res) {
  const fmt = new Intl.DateTimeFormat(req.lang === 'gu' ? 'gu-IN' : 'en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const { t } = res.locals;
  return svc.celebrations(req.app.locals.db).map((c) => ({
    ...c, when: c.inDays === 0 ? t('Today') : c.inDays === 1 ? t('Tomorrow') : fmt.format(new Date(`${c.date}T12:00:00Z`)),
  }));
}

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
    WHERE directory_listed = 1 AND contact_type = 'member'
      AND (password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id))
      AND (? = '' OR first_name || ' ' || last_name LIKE ? OR city LIKE ? OR native_place LIKE ?)
    ORDER BY last_name COLLATE NOCASE, first_name COLLATE NOCASE
  `).all(q, like, like, like);
  res.render('member/directory', { title: 'Member directory', members, q });
});

router.get('/news', requireAuth, (req, res) => {
  const posts = req.app.locals.db.prepare('SELECT * FROM news_posts ORDER BY created_at DESC, id DESC').all();
  res.render('member/news', { title: 'News', posts, eventNews: svc.eventAnnouncements(req.app.locals.db, req.user.id), celebrations: celebrationList(req, res) });
});

// "2 hours ago", "Yesterday" or the date, for a story's UTC publish time.
function newsWhen(res, utc) {
  const { t, plural, fmtDay } = res.locals;
  const minutes = Math.max(0, Math.round((Date.now() - new Date(`${utc.replace(' ', 'T')}Z`).getTime()) / 60000));
  if (minutes < 2) return t('Just now');
  if (minutes < 60) return plural(minutes, '1 minute ago', '{n} minutes ago');
  if (minutes < 24 * 60) return plural(Math.floor(minutes / 60), '1 hour ago', '{n} hours ago');
  if (minutes < 48 * 60) return t('Yesterday');
  return fmtDay(utc);
}

// English readers see English sources by default; Gujarati readers see both languages.
const defaultNewsLang = (req) => (req.lang === 'gu' ? '' : 'en');

// Gujarat & India news: headlines with a short "quick read", and a link to the full story on the newspaper's site.
router.get('/news/india', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const choices = newsfeed.newsChoices(db);
  const lang = req.query.lang === 'all' ? '' : ['gu', 'en'].includes(req.query.lang) ? req.query.lang : defaultNewsLang(req);
  const topic = choices.topics.includes(req.query.topic) ? req.query.topic : '';
  const page = parseIntInRange(req.query.page, 1, 20) || 1;
  const perPage = 15;
  let { items, more } = newsfeed.visibleNews(db, { lang: choices.langs.includes(lang) ? lang : '', topic, limit: perPage * page });
  items = items.map((it) => ({ ...it, when: newsWhen(res, it.published_at) }));
  res.render('member/news_india', { title: 'Gujarat & India news', items, more, page, lang, topic, choices });
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
  const past = db.prepare(`SELECT id, title, title_gu, starts_at FROM events WHERE status = 'published' AND starts_at < ?
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
  const events = db.prepare(`SELECT e.id, e.title, e.title_gu, e.starts_at, e.status, r.status AS my_status FROM events e
    LEFT JOIN rsvps r ON r.event_id = e.id AND r.user_id = ? AND r.status != 'cancelled'
    WHERE e.status != 'draft' AND substr(e.starts_at, 1, 7) = ? ORDER BY e.starts_at`).all(req.user.id, month);
  const byDay = Map.groupBy(events, (e) => Number(e.starts_at.slice(8, 10)));
  const locale = req.lang === 'gu' ? 'gu-IN' : 'en-US';
  const shift = (delta) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    return d.toISOString().slice(0, 7);
  };
  res.render('member/calendar', {
    title: 'Events calendar', month, byDay, daysInMonth, leadingBlanks: first.getUTCDay(),
    monthLabel: first.toLocaleString(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    // Week starting Sunday: Jan 4 2026 was a Sunday.
    weekdays: [...Array(7)].map((_, i) => weekdayName(new Date(Date.UTC(2026, 0, 4 + i)), locale)),
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
  // Already paid for this event, even on an RSVP they cancelled (non-refundable, so it counts toward a new one).
  const previous = rsvp || db.prepare('SELECT id FROM rsvps WHERE event_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1').get(event.id, req.user.id);
  res.render('member/event', {
    title: event.title, event, rsvp, membership, open: svc.rsvpWindowOpen(event),
    due: rsvp ? svc.amountDue(db, rsvp) : 0,
    paidCents: previous ? svc.paidForRsvp(db, previous.id) : 0,
    maxParty: svc.maxPartySize(db, event, req.user.id),
    familyListed: svc.getHousehold(db, svc.householdOwnerId(db, req.user.id)).length,
    people: svc.eventPeople(db, event, req.user.id),
    albums: db.prepare(`SELECT a.id FROM photo_albums a WHERE a.event_id = ?
      AND EXISTS (SELECT 1 FROM photos p WHERE p.album_id = a.id AND p.status = 'approved') ORDER BY a.id`).all(event.id),
    isFamilyLogin: Boolean(req.user.owner_id),
    spotsLeft: event.capacity ? Math.max(0, event.capacity - svc.reservedSeats(db, event.id)) : null,
    questions: svc.eventQuestions(event),
    answers: rsvp ? JSON.parse(rsvp.answers || '[]') : [],
    earlyBird: svc.earlyBirdActive(event),
    prices: rsvpPrices(event),
  });
});

// Per-person prices for the RSVP form's running estimate (forms.js).
// Prices for the form's running total (cents): per person (by rate) and per guest (by kind).
function rsvpPrices(event) {
  const guests = svc.guestPrices(event);
  return { member: svc.memberPrice(event), nonmember: event.guest_fee_cents ?? event.fee_cents, free: 0,
    student: guests.student ?? null, outofstate: guests.outofstate ?? null, guests };
}

router.post('/events/:id/rsvp', requireAuth, async (req, res) => {
  const { db, gateway } = req.app.locals;
  // The form lists the family by name (checkboxes named "people"); `choose` marks that form,
  // so ticking nobody is an error rather than falling back to a head count.
  const people = req.body.choose ? [].concat(req.body.people ?? []) : null;
  const fromTicket = req.body.from === 'ticket';
  const { rsvp, amountDue, qrReplaced, waitlisted } = svc.upsertRsvp(db, {
    eventId: Number(req.params.id), userId: req.user.id, people, keepAnswers: fromTicket,
    partySize: parseIntInRange(req.body.party_size, 1, 1000),
    // Guests by kind: guests_instate, guests_outofstate, guests_student, guests_child (older forms: guests).
    guests: Object.fromEntries(svc.GUEST_TYPES.map((k) => [k, req.body[`guests_${k}`] ?? (k === 'instate' ? req.body.guests : 0)])
      .map(([k, v]) => [k, v ? parseIntInRange(v, 0, 1000) ?? -1 : 0])),
    selfType: fromTicket ? undefined : (req.body.self_type || null),
    couponCode: String(req.body.coupon || '').trim(),
    body: req.body,
    joinWaitlist: Boolean(req.body.waitlist),
    // Paid events: "online" (card now) or "door" (cash at the entrance). Not sent from My tickets.
    payAtDoor: req.body.pay === 'door' ? true : req.body.pay === 'online' ? false : undefined,
  });
  const n = rsvp.party_size;
  if (waitlisted) {
    req.flash('info', n === 1
      ? "The event is full, so you're on the waitlist for 1 person. If seats open up you'll be moved in automatically."
      : "The event is full, so you're on the waitlist for {n} people. If seats open up you'll be moved in automatically.", { n });
    return res.redirect(fromTicket ? `/tickets/${rsvp.id}` : `/events/${req.params.id}`);
  }
  if (qrReplaced) {
    req.flash('info', n === 1
      ? 'Your RSVP is now for 1 person. A new QR code was issued — your old QR code no longer works.'
      : 'Your RSVP is now for {n} people. A new QR code was issued — your old QR code no longer works.', { n });
  }
  if (rsvp.discount_cents) req.flash('success', 'Coupon {code} applied: {amount} off.', { code: rsvp.coupon_code, amount: req.app.locals.money(rsvp.discount_cents) });
  if (amountDue === 0) {
    if (!qrReplaced) req.flash('success', 'You are registered! Show this QR code at the entrance.');
    return res.redirect(`/tickets/${rsvp.id}`);
  }
  if (rsvp.status === 'confirmed') { // paying at the door
    req.flash('success', 'You are registered! Please pay {amount} in cash at the door and show this QR code.', { amount: req.app.locals.money(amountDue) });
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

// Started paying online but would rather pay cash at the door: the QR code is ready now.
router.post('/events/:id/pay-at-door', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const rsvp = db.prepare(`SELECT * FROM rsvps WHERE event_id = ? AND user_id = ?`).get(req.params.id, req.user.id);
  if (!rsvp) throw new svc.UserError('Please RSVP first.');
  const updated = svc.payAtDoorInstead(db, { rsvpId: rsvp.id, userId: req.user.id });
  req.flash('success', 'You are registered! Please pay {amount} in cash at the door and show this QR code.', { amount: req.app.locals.money(svc.amountDue(db, updated)) });
  res.redirect(`/tickets/${rsvp.id}`);
});

router.post('/events/:id/cancel', requireAuth, (req, res) => {
  svc.cancelRsvp(req.app.locals.db, { eventId: Number(req.params.id), userId: req.user.id });
  req.flash('success', 'Your RSVP was cancelled.');
  res.redirect(`/events/${req.params.id}`);
});

// ---------- Tickets (QR codes) ----------

function loadTicket(req) {
  const { db } = req.app.locals;
  const rsvp = db.prepare(`
    SELECT r.*, e.title, e.title_gu, e.starts_at, e.location, u.first_name AS holder_first, u.last_name AS holder_last
    FROM rsvps r JOIN events e ON e.id = r.event_id JOIN users u ON u.id = r.user_id
    WHERE r.id = ?
  `).get(req.params.id);
  // Members see only their own family's tickets (admins included, when using the member app).
  if (!rsvp || !svc.familyUserIds(db, req.user.id).includes(rsvp.user_id)) return null;
  return rsvp;
}

router.get('/tickets', requireAuth, (req, res) => {
  res.render('member/tickets', { title: 'My tickets', tickets: familyTickets(req.app.locals.db, req.user.id) });
});

router.get('/tickets/:id', requireAuth, async (req, res) => {
  const { db } = req.app.locals;
  const rsvp = loadTicket(req);
  if (!rsvp) return res.status(404).render('error', { title: 'Not found', message: 'Ticket not found.' });
  const qrDataUrl = rsvp.status === 'confirmed'
    ? await QRCode.toDataURL(ticketUrl(req.app.locals.config, rsvp.qr_token), { width: 320, margin: 2 })
    : null;
  const event = svc.getEvent(db, rsvp.event_id);
  const mine = rsvp.user_id === req.user.id;
  // The holder can change who's coming here, until check-in or RSVPs close.
  const canChange = mine && rsvp.status !== 'cancelled' && !rsvp.checked_in_at && svc.rsvpWindowOpen(event);
  res.render('member/ticket', {
    title: `Ticket — ${rsvp.title}`, rsvp, qrDataUrl, event, mine, canChange, prices: rsvpPrices(event), paidCents: canChange ? svc.paidForRsvp(db, rsvp.id) : 0,
    ticketCode: rsvp.qr_token ? svc.shortCode(rsvp.qr_token) : null,
    due: svc.amountDue(db, rsvp),
    names: svc.attendeeNames(db, rsvp),
    people: canChange ? svc.eventPeople(db, event, req.user.id) : [],
  });
});

// Paying online at the door: the volunteer's screen shows a QR code that opens this page on the family's phone.
router.get('/tickets/:id/pay', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const rsvp = loadTicket(req);
  if (!rsvp) return res.status(404).render('error', { title: 'Not found', message: 'Ticket not found.' });
  res.render('member/pay_now', { title: 'Pay online', rsvp, due: svc.amountDue(db, rsvp), paidCents: svc.paidForRsvp(db, rsvp.id) });
});

router.post('/tickets/:id/pay', requireAuth, async (req, res) => {
  const { db, gateway } = req.app.locals;
  const rsvp = loadTicket(req);
  if (!rsvp) return res.status(404).render('error', { title: 'Not found', message: 'Ticket not found.' });
  const payment = svc.createEventPayment(db, { rsvpId: rsvp.id, userId: rsvp.user_id, payerId: req.user.id });
  const url = await gateway.startCheckout(payment, req.user);
  if (!url) throw new svc.UserError('Online payment is not available. Please pay an organizer.');
  res.redirect(303, url);
});

router.get('/tickets/:id/qr.png', requireAuth, async (req, res) => {
  const rsvp = loadTicket(req);
  if (!rsvp || rsvp.status !== 'confirmed') return res.sendStatus(404);
  res.type('png');
  res.set('Content-Disposition', `inline; filename="ticket-${rsvp.id}.png"`);
  // With the short ticket code under the QR code, for the door to type if it won't scan.
  res.send(await require('../ticketImage').ticketPng(ticketUrl(req.app.locals.config, rsvp.qr_token), svc.shortCode(rsvp.qr_token)));
});

// ---------- Membership & payments ----------

router.get('/membership', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  const membership = svc.membershipStatus(db, req.user.id);
  // Family logins are covered by the family's membership; the member who holds it renews it.
  const owner = req.user.owner_id ? db.prepare('SELECT first_name, last_name FROM users WHERE id = ?').get(req.user.owner_id) : null;
  if (owner) {
    return res.render('member/membership_family', {
      title: 'Membership', membership, owner,
      coverageParts: membership.plan ? svc.planCoverageParts(membership.plan) : null,
    });
  }
  res.render('member/membership', {
    title: 'Membership',
    membership,
    coverageParts: membership.plan ? svc.planCoverageParts(membership.plan) : null,
    history: db.prepare(`SELECT m.*, p.name AS plan_name FROM memberships m LEFT JOIN membership_plans p ON p.id = m.plan_id
                         WHERE m.user_id = ? ORDER BY m.end_date DESC, m.id DESC`).all(req.user.id),
    plans: db.prepare('SELECT * FROM membership_plans WHERE active = 1 ORDER BY sort_order, amount_cents').all().map((plan) => ({
      ...plan,
      coverageParts: svc.planCoverageParts(plan),
      quote: svc.membershipQuote(db, plan, req.user.id),
      blocked: svc.planIneligibility(db, plan, req.user),
    })),
  });
});

router.post('/membership/pay', requireAuth, async (req, res) => {
  const { db, gateway } = req.app.locals;
  if (req.user.owner_id) throw new svc.UserError('Your membership is part of your family membership. The member who holds it renews it.');
  const { payment, staleCheckouts } = svc.createMembershipPayment(db, { planId: Number(req.body.plan_id), user: req.user });
  await gateway.expireCheckouts(staleCheckouts); // close payment pages left open in other tabs
  if (!payment) {
    req.flash('success', 'Your membership is active.');
    return res.redirect('/membership');
  }
  const url = await gateway.startCheckout(payment, req.user);
  if (!url) throw new svc.UserError('Online payment is not available yet. Please pay an organizer.');
  res.redirect(303, url);
});

// A payment plus what it was for (level / event / fund) so it can be described in either language.
const PAYMENT_DETAILS_SQL = `
  SELECT p.*, u.first_name, u.last_name, u.email, u.address_line1, u.address_line2, u.city, u.state, u.postal_code,
         mp.name AS plan_name, mp.name_gu AS plan_name_gu, e.title AS event_title, e.title_gu AS event_title_gu,
         r.party_size, c.title AS campaign_title
  FROM payments p JOIN users u ON u.id = p.user_id
  LEFT JOIN membership_plans mp ON p.kind IN ('membership', 'membership_upgrade') AND mp.id = p.reference_id
  LEFT JOIN rsvps r ON p.kind = 'event' AND r.id = p.reference_id
  LEFT JOIN events e ON e.id = r.event_id
  LEFT JOIN campaigns c ON p.kind = 'donation' AND c.id = p.reference_id`;

// Printable receipt for any paid payment (members see their own; the admin area sees all).
router.get('/receipts/:id', requireAuth, (req, res) => {
  const payment = req.app.locals.db.prepare(`${PAYMENT_DETAILS_SQL} WHERE p.id = ? AND p.status = 'paid'`).get(req.params.id);
  if (!payment || (payment.user_id !== req.user.id && !req.session.adminMode)) {
    return res.status(404).render('error', { title: 'Not found', message: 'Receipt not found.' });
  }
  res.render('member/receipt', { title: `Receipt ${receiptNumber(payment.id)}`, payment, number: receiptNumber(payment.id) });
});

router.get('/payments', requireAuth, (req, res) => {
  const payments = req.app.locals.db.prepare(`${PAYMENT_DETAILS_SQL} WHERE p.user_id = ? AND p.status = 'paid' ORDER BY p.paid_at DESC`)
    .all(req.user.id);
  res.render('member/payments', { title: 'My payments', payments });
});

module.exports = router;
