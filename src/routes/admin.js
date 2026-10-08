const express = require('express');
const bcrypt = require('bcryptjs');
const { requireAdmin } = require('../middleware');
const { getContent, setContent } = require('../site');
const newsfeed = require('../newsfeed');
const { TAGS, cleanTags, cleanEmail, addContact, temporaryPassword, importContacts } = require('../contacts');
const { csvUpload, removeUpload } = require('../uploads');
const svc = require('../services');
const { DEMO_ACCOUNTS } = require('../demo');
const { parseMoney, parseIntInRange, nowLocal, toCsv, localTimestamp } = require('../util');

const router = express.Router();
router.use(requireAdmin);

// Optional photo on the event form (multipart; the CSRF token travels in the form's URL).
const eventImage = (req, res, next) => req.app.locals.imageUpload.single('image')(req, res, next);

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
  // Only payments the app itself refused count (members can write their own notes on donations).
  const refundsNeeded = db.prepare(`SELECT COUNT(*) AS n FROM payments WHERE refunded_at IS NOT NULL AND note LIKE 'REFUND NEEDED%'`).get().n;
  res.render('admin/dashboard', { title: 'Admin', stats, events, recentPayments, refundsNeeded });
});

router.post('/demo/reset', (req, res) => {
  if (!req.app.locals.config.demoMode) return res.sendStatus(404);
  require('../demo').resetDemo(req.app.locals.db, { photosDir: req.app.locals.config.photosDir });
  req.flash('success', 'Demo data has been reset. Event dates are relative to today.');
  res.redirect('/admin');
});

// ---------- Members ----------

// Contact search with filters: text, membership status, level, tag, city, login.
function searchMembers(db, filters = {}) {
  const where = [];
  const args = [];
  const q = String(filters.q || '').trim();
  if (q) {
    where.push(`(u.first_name || ' ' || u.last_name LIKE ? OR u.email LIKE ? OR u.phone LIKE ? OR u.city LIKE ? OR u.native_place LIKE ?)`);
    args.push(...Array(5).fill(`%${q}%`));
  }
  const now = nowLocal().slice(0, 10);
  if (filters.status === 'active') { where.push('m.end_date >= ?'); args.push(now); }
  if (filters.status === 'expired') { where.push('m.end_date < ?'); args.push(now); }
  if (filters.status === 'none') where.push('m.end_date IS NULL');
  if (filters.level) { where.push('m.plan_id = ?'); args.push(Number(filters.level)); }
  if (filters.tag === 'Donor') where.push(`(',' || u.tags || ',' LIKE '%,Donor,%' OR EXISTS (SELECT 1 FROM payments d WHERE d.user_id = u.id AND d.kind = 'donation' AND d.status = 'paid'))`);
  else if (filters.tag) { where.push(`',' || u.tags || ',' LIKE ?`); args.push(`%,${filters.tag},%`); }
  if (filters.city) { where.push('u.city = ? COLLATE NOCASE'); args.push(filters.city); }
  if (filters.login === 'yes') where.push('u.password_hash IS NOT NULL');
  if (filters.login === 'no') where.push('u.password_hash IS NULL');
  return db.prepare(`
    SELECT u.*, m.end_date AS membership_end, p.name AS level_name,
           (SELECT COUNT(*) FROM household_members h WHERE h.user_id = u.id) AS household_count,
           EXISTS (SELECT 1 FROM payments d WHERE d.user_id = u.id AND d.kind = 'donation' AND d.status = 'paid') AS is_donor
    FROM users u
    LEFT JOIN memberships m ON m.id = (SELECT id FROM memberships WHERE user_id = u.id ORDER BY end_date DESC, id DESC LIMIT 1)
    LEFT JOIN membership_plans p ON p.id = m.plan_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY u.last_name COLLATE NOCASE, u.first_name COLLATE NOCASE
  `).all(...args);
}

const FILTER_KEYS = ['q', 'status', 'level', 'tag', 'city', 'login'];
const pickFilters = (query) => Object.fromEntries(FILTER_KEYS.map((k) => [k, String(query[k] || '').trim()]));

router.get('/members', (req, res) => {
  const { db } = req.app.locals;
  const filters = pickFilters(req.query);
  res.render('admin/members', {
    title: 'Contacts', members: searchMembers(db, filters), filters, today: nowLocal().slice(0, 10), tags: TAGS,
    plans: db.prepare('SELECT id, name FROM membership_plans ORDER BY sort_order, amount_cents').all(),
    cities: db.prepare(`SELECT DISTINCT city FROM users WHERE city IS NOT NULL AND city != '' ORDER BY city COLLATE NOCASE`).all().map((r) => r.city),
    exportQuery: new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString(),
  });
});

router.get('/members.csv', (req, res) => {
  const { db } = req.app.locals;
  const members = searchMembers(db, pickFilters(req.query));
  const household = db.prepare('SELECT * FROM household_members ORDER BY user_id, id').all();
  const famBy = Map.groupBy(household, (h) => h.user_id);
  const rows = [['First name', 'Last name', 'Email', 'Phone', 'Address 1', 'Address 2', 'City', 'State', 'Postal code',
    'Native place', 'Date of birth', 'Occupation', 'Membership level', 'Membership valid until', 'Tags', 'Family members', 'Has login', 'Added']];
  for (const m of members) {
    const fam = (famBy.get(m.id) || []).map((h) => `${h.name}${h.relationship ? ` (${h.relationship})` : ''}`).join('; ');
    const tags = [...new Set([...m.tags.split(',').filter(Boolean), ...(m.is_donor ? ['Donor'] : [])])].join(', ');
    rows.push([m.first_name, m.last_name, m.email, m.phone, m.address_line1, m.address_line2, m.city, m.state,
      m.postal_code, m.native_place, m.date_of_birth, m.occupation, m.level_name, m.membership_end, tags, fam,
      m.password_hash ? 'yes' : 'no', localTimestamp(m.created_at)]);
  }
  res.attachment('contacts.csv').type('text/csv').send(toCsv(rows));
});

router.get('/members/new', (req, res) => {
  res.render('admin/member_new', { title: 'Add contact', tags: TAGS });
});

router.post('/members/new', (req, res) => {
  const { id, temporaryPassword } = addContact(req.app.locals.db, req.body);
  req.flash('success', temporaryPassword
    ? `Contact added with a login. Temporary password: ${temporaryPassword} — share it with them.`
    : 'Contact added.');
  res.redirect(`/admin/members/${id}`);
});

router.get('/import', (req, res) => {
  res.render('admin/import', { title: 'Import contacts', result: null });
});

router.post('/import', csvUpload.single('file'), (req, res) => {
  if (!req.file) throw new svc.UserError('Please choose a CSV file to import.');
  const result = importContacts(req.app.locals.db, req.file.buffer.toString('utf8'));
  res.render('admin/import', { title: 'Import contacts', result });
});

router.get('/members/:id', (req, res) => {
  const { db } = req.app.locals;
  const member = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!member) return notFound(res, 'Member');
  const membership = svc.membershipStatus(db, member.id);
  const household = svc.getHousehold(db, member.id);
  // A family login (spouse etc. with their own sign-in) is covered by the member who listed them.
  const owner = member.owner_id ? db.prepare('SELECT id, first_name, last_name FROM users WHERE id = ?').get(member.owner_id) : null;
  res.render('admin/member', {
    owner,
    coverage: membership.plan ? svc.planCoverage(membership.plan) : null,
    coverageProblems: membership.active && membership.plan ? svc.planProblems(membership.plan, household) : [],
    title: `${member.first_name} ${member.last_name}`,
    member,
    household,
    membership,
    relationships: Object.keys(svc.RELATIONSHIPS),
    tags: TAGS,
    payments: db.prepare(`SELECT * FROM payments WHERE user_id = ? AND status = 'paid' ORDER BY paid_at DESC`).all(member.id),
    rsvps: db.prepare(`SELECT r.*, e.title, e.starts_at FROM rsvps r JOIN events e ON e.id = r.event_id
                       WHERE r.user_id = ? ORDER BY e.starts_at DESC`).all(member.id),
    plans: db.prepare('SELECT * FROM membership_plans ORDER BY active DESC, sort_order, amount_cents').all(),
    campaigns: db.prepare('SELECT id, title FROM campaigns WHERE active = 1 ORDER BY title').all(),
  });
});

// Admins can add family members beyond the member's level (e.g. agreed exceptions); they get a warning.
router.post('/members/:id/household', (req, res) => {
  const birthYear = req.body.birth_year ? parseIntInRange(req.body.birth_year, 1900, new Date().getFullYear()) : null;
  const { name, exceedsPlan } = svc.addHouseholdMember(req.app.locals.db, {
    userId: Number(req.params.id), name: req.body.name, relationship: req.body.relationship, birthYear, override: true,
  });
  req.flash(exceedsPlan ? 'info' : 'success', exceedsPlan
    ? `${name} added. Note: this is more than the member's current level covers.`
    : `${name} added.`);
  res.redirect(`/admin/members/${req.params.id}#family`);
});

router.post('/members/:id/household/:hid/delete', (req, res) => {
  svc.removeHouseholdMember(req.app.locals.db, { ownerId: Number(req.params.id), householdId: Number(req.params.hid) });
  res.redirect(`/admin/members/${req.params.id}#family`);
});

router.post('/members/:id', (req, res) => {
  const { db } = req.app.locals;
  svc.updateProfile(db, req.params.id, req.body);
  const email = cleanEmail(req.body.email);
  if (email && db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, req.params.id)) {
    throw new svc.UserError('Another contact already uses that email.');
  }
  db.prepare('UPDATE users SET notes = ?, email = ?, tags = ? WHERE id = ?')
    .run(String(req.body.notes || '').slice(0, 2000) || null, email, cleanTags(req.body.tags), req.params.id);
  req.flash('success', 'Member profile saved.');
  res.redirect(`/admin/members/${req.params.id}`);
});

// In the demo, the accounts behind the "Admin (committee)" and "Door volunteer" sign-in buttons keep their access,
// so those buttons always work during a presentation. (Other members can be changed freely to show these features.)
function guardDemoButton(req, id, breaksButton) {
  if (!req.app.locals.config.demoMode) return;
  const email = req.app.locals.db.prepare('SELECT email FROM users WHERE id = ?').get(id)?.email;
  const account = DEMO_ACCOUNTS.find((a) => a.staff && a.email === email);
  if (account && breaksButton(account)) {
    throw new svc.UserError('This person is behind the "{label}" demo sign-in button, so their access stays as it is in the demo. Try it with another member, such as Priya Shah.', { label: account.label });
  }
}

router.post('/members/:id/role', (req, res) => {
  const { db } = req.app.locals;
  const role = req.body.role === 'admin' ? 'admin' : 'member';
  guardDemoButton(req, req.params.id, (account) => (account.door ? role === 'admin' : role !== 'admin'));
  if (Number(req.params.id) === req.user.id && role !== 'admin') throw new svc.UserError('You cannot remove your own admin access.');
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  req.flash('success', role === 'admin' ? 'Member is now an administrator.' : 'Admin access removed.');
  res.redirect(`/admin/members/${req.params.id}`);
});

// Door volunteers can use the check-in scanner (and nothing else in the admin area).
router.post('/members/:id/checkin-access', (req, res) => {
  const { db } = req.app.locals;
  const contact = db.prepare('SELECT email, password_hash, tags FROM users WHERE id = ?').get(req.params.id);
  if (!contact) return notFound(res, 'Member');
  const grant = req.body.access === '1';
  if (!grant) guardDemoButton(req, req.params.id, (account) => account.door);
  if (grant && !contact.email) throw new svc.UserError('Add an email address first — it is what they sign in with.');
  // Door volunteers are also tagged Volunteer, so they show up when filtering contacts by that tag.
  // Turning door access off leaves the tag: they may still volunteer in other ways.
  const tags = grant ? cleanTags([...contact.tags.split(','), 'Volunteer']) : contact.tags;
  db.prepare('UPDATE users SET checkin_access = ?, tags = ? WHERE id = ?').run(grant ? 1 : 0, tags, req.params.id);
  req.flash('success', grant
    ? `Door check-in turned on. They sign in at Committee & volunteer sign-in (link on the sign-in page) to open check-in.${contact.password_hash ? '' : ' They have no app login yet — use "Create app login" below.'}`
    : 'Door check-in turned off.');
  res.redirect(req.body.return_to === '/admin/checkin' ? '/admin/checkin' : `/admin/members/${req.params.id}`);
});

router.post('/members/:id/reset-password', (req, res) => {
  const contact = req.app.locals.db.prepare('SELECT email FROM users WHERE id = ?').get(req.params.id);
  if (!contact?.email) throw new svc.UserError('Add an email address first — it is what they sign in with.');
  const temp = temporaryPassword();
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
    svc.assertCanRenew(db, member.id); // same one-year-ahead limit as online renewals
    const amount = req.body.amount ? parseMoney(req.body.amount) : plan.amount_cents;
    if (!(amount > 0)) throw new svc.UserError('Enter the amount received.');
    payment = svc.createPayment(db, { userId: member.id, kind: 'membership', referenceId: plan.id, amountCents: amount,
      description: `Membership — ${plan.name}` });
  } else if (req.body.kind === 'donation') {
    payment = svc.createDonationPayment(db, {
      userId: member.id, campaignId: Number(req.body.campaign_id) || null, amountCents: parseMoney(req.body.amount), note: req.body.description,
    });
  } else {
    const amount = parseMoney(req.body.amount);
    const description = String(req.body.description || '').trim().slice(0, 200);
    if (!(amount > 0) || !description) throw new svc.UserError('Enter an amount and description.');
    payment = svc.createPayment(db, { userId: member.id, kind: 'other', amountCents: amount, description });
  }
  const result = svc.markPaymentPaid(db, payment.id, { method, providerRef: String(req.body.reference || '').slice(0, 100) || null, recordedBy: req.user.id });
  if (result === 'refund') {
    // Another payment got there first (e.g. the member paid online a moment ago).
    req.flash('error', 'Not recorded: membership is already paid one year ahead. Please give this money back to the member.');
    return res.redirect(`/admin/members/${member.id}`);
  }
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
  const guestFee = body.allow_guests ? parseMoney(body.guest_fee) : null;
  const maxGuests = body.allow_guests ? parseIntInRange(body.max_guests || 4, 1, 50) : 4;
  const earlyFee = String(body.early_fee || '').trim() ? parseMoney(body.early_fee) : null;
  const dt = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
  if (!title) throw new svc.UserError('Event title is required.');
  if (!dt.test(startsAt)) throw new svc.UserError('Please choose a start date and time.');
  if (body.ends_at && !dt.test(body.ends_at)) throw new svc.UserError('End time is invalid.');
  if (body.rsvp_deadline && !dt.test(body.rsvp_deadline)) throw new svc.UserError('RSVP deadline is invalid.');
  if (Number.isNaN(fee)) throw new svc.UserError('Fee must be an amount like 15 or 15.50.');
  if (guestFee !== null && Number.isNaN(guestFee)) throw new svc.UserError('Guest price must be an amount like 20 or 20.00.');
  if (earlyFee !== null && Number.isNaN(earlyFee)) throw new svc.UserError('Early-bird price must be an amount like 12.');
  if (earlyFee !== null && !dt.test(body.early_until || '')) throw new svc.UserError('Choose when the early-bird price ends.');
  if (body.capacity && !capacity) throw new svc.UserError('Capacity must be a positive number.');
  if (!maxParty) throw new svc.UserError('Max people per RSVP must be between 1 and 100.');
  if (!maxGuests) throw new svc.UserError('Max guests per RSVP must be between 1 and 50.');
  return {
    title,
    description: String(body.description || '').trim().slice(0, 5000) || null,
    title_gu: String(body.title_gu || '').trim().slice(0, 200) || null,
    description_gu: String(body.description_gu || '').trim().slice(0, 5000) || null,
    location: String(body.location || '').trim().slice(0, 300) || null,
    starts_at: startsAt,
    ends_at: body.ends_at || null,
    rsvp_deadline: body.rsvp_deadline || null,
    fee_cents: fee,
    capacity,
    max_party_size: maxParty,
    members_only: body.members_only ? 1 : 0,
    status: ['draft', 'published', 'cancelled'].includes(body.status) ? body.status : 'published',
    guest_fee_cents: guestFee,
    max_guests: maxGuests,
    early_fee_cents: earlyFee,
    early_until: earlyFee !== null ? body.early_until : null,
    questions: JSON.stringify(svc.parseQuestions(body.questions)),
  };
}

const EVENT_COLUMNS = ['title', 'description', 'title_gu', 'description_gu', 'location', 'starts_at', 'ends_at', 'rsvp_deadline', 'fee_cents', 'capacity',
  'max_party_size', 'members_only', 'status', 'guest_fee_cents', 'max_guests', 'early_fee_cents', 'early_until', 'questions'];

router.get('/events', (req, res) => {
  const { db } = req.app.locals;
  const events = db.prepare('SELECT * FROM events ORDER BY starts_at DESC').all()
    .map((e) => ({ ...e, stats: svc.eventStats(db, e.id) }));
  res.render('admin/events', { title: 'Events', events, now: nowLocal() });
});

router.get('/events/new', (req, res) => {
  res.render('admin/event_form', {
    title: 'New event', questionsText: '',
    event: { max_party_size: 10, max_guests: 4, status: 'published', location: getContent(req.app.locals.db, 'org').venue },
  });
});

router.post('/events', eventImage, (req, res) => {
  const e = parseEventForm(req.body);
  const id = req.app.locals.db.prepare(`INSERT INTO events (${EVENT_COLUMNS.join(', ')}, image_path, created_by)
    VALUES (${EVENT_COLUMNS.map(() => '?').join(', ')}, ?, ?)`)
    .run(...EVENT_COLUMNS.map((c) => e[c]), req.file ? `/uploads/${req.file.filename}` : null, req.user.id).lastInsertRowid;
  req.flash('success', 'Event created.');
  res.redirect(`/admin/events/${id}`);
});

router.get('/events/:id/edit', (req, res) => {
  const event = svc.getEvent(req.app.locals.db, req.params.id);
  if (!event) return notFound(res, 'Event');
  res.render('admin/event_form', { title: `Edit — ${event.title}`, event, questionsText: svc.questionsToText(svc.eventQuestions(event)) });
});

router.post('/events/:id', eventImage, (req, res) => {
  const { db, config } = req.app.locals;
  const event = svc.getEvent(db, req.params.id);
  if (!event) return notFound(res, 'Event');
  const e = parseEventForm(req.body);
  let image = event.image_path;
  if (req.file || req.body.remove_image) {
    removeUpload(config, image);
    image = req.file ? `/uploads/${req.file.filename}` : null;
  }
  db.prepare(`UPDATE events SET ${EVENT_COLUMNS.map((c) => `${c} = ?`).join(', ')}, image_path = ? WHERE id = ?`)
    .run(...EVENT_COLUMNS.map((c) => e[c]), image, event.id);
  // More seats (or a cancelled RSVP elsewhere) may let people off the waitlist.
  const promoted = svc.promoteWaitlist(db, event.id);
  req.flash('success', promoted.length ? `Event saved. ${promoted.length} RSVP${promoted.length === 1 ? '' : 's'} moved off the waitlist.` : 'Event saved.');
  res.redirect(`/admin/events/${event.id}`);
});

router.post('/events/:id/coupons', (req, res) => {
  const { db } = req.app.locals;
  const event = svc.getEvent(db, req.params.id);
  if (!event) return notFound(res, 'Event');
  const code = String(req.body.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,30}$/.test(code)) throw new svc.UserError('Coupon codes use 3–30 letters or numbers, e.g. GARBA10.');
  const percent = req.body.kind === 'percent' ? parseIntInRange(req.body.value, 1, 100) : null;
  const amount = req.body.kind === 'amount' ? parseMoney(req.body.value) : null;
  if (!percent && !(amount > 0)) throw new svc.UserError('Enter a discount: a percentage (1–100) or a dollar amount.');
  const maxUses = req.body.max_uses ? parseIntInRange(req.body.max_uses, 1, 100000) : null;
  if (db.prepare('SELECT 1 FROM coupons WHERE code = ?').get(code)) throw new svc.UserError('That code already exists.');
  db.prepare('INSERT INTO coupons (code, event_id, percent_off, amount_off_cents, max_uses, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(code, event.id, percent, amount, maxUses, /^\d{4}-\d{2}-\d{2}$/.test(req.body.expires_at || '') ? req.body.expires_at : null);
  req.flash('success', `Coupon ${code} created.`);
  res.redirect(`/admin/events/${event.id}#coupons`);
});

router.post('/coupons/:id/toggle', (req, res) => {
  const { db } = req.app.locals;
  const coupon = db.prepare('SELECT * FROM coupons WHERE id = ?').get(req.params.id);
  if (!coupon) return notFound(res, 'Coupon');
  db.prepare('UPDATE coupons SET active = 1 - active WHERE id = ?').run(coupon.id);
  res.redirect(`/admin/events/${coupon.event_id}#coupons`);
});

function eventAttendees(db, event) {
  return db.prepare(`
    SELECT r.*, u.first_name, u.last_name, u.email, u.phone
    FROM rsvps r JOIN users u ON u.id = r.user_id
    WHERE r.event_id = ?
    ORDER BY r.status = 'cancelled', u.last_name COLLATE NOCASE, u.first_name COLLATE NOCASE
  `).all(event.id).map((r) => ({
    ...r, paid_cents: svc.paidForRsvp(db, r.id), answers: JSON.parse(r.answers || '[]'), names: svc.attendeeNames(db, r),
  }));
}

router.get('/events/:id', (req, res) => {
  const { db } = req.app.locals;
  const event = svc.getEvent(db, req.params.id);
  if (!event) return notFound(res, 'Event');
  res.render('admin/event', {
    title: event.title, event,
    stats: svc.eventStats(db, event.id),
    revenue: svc.eventRevenue(db, event.id),
    attendees: eventAttendees(db, event),
    questions: svc.eventQuestions(event),
    coupons: db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM rsvps r WHERE r.coupon_code = c.code COLLATE NOCASE AND r.status != 'cancelled') AS uses
                         FROM coupons c WHERE c.event_id = ? ORDER BY c.created_at DESC`).all(event.id),
  });
});

router.get('/events/:id/attendees.csv', (req, res) => {
  const { db, money } = req.app.locals;
  const event = svc.getEvent(db, req.params.id);
  if (!event) return notFound(res, 'Event');
  const questions = svc.eventQuestions(event);
  const rows = [['First name', 'Last name', 'Email', 'Phone', 'Status', 'People registered', 'Names', 'Of whom guests', 'Total price',
    'Paid', 'Coupon', ...questions.map((q) => q.label), 'Checked in at', 'People checked in', 'RSVP date']];
  for (const a of eventAttendees(db, event)) {
    rows.push([a.first_name, a.last_name, a.email, a.phone, a.status, a.party_size, a.names.join(', '), a.guest_count, money(a.total_cents),
      money(a.paid_cents), a.coupon_code, ...questions.map((q, i) => a.answers[i]?.answer ?? ''),
      localTimestamp(a.checked_in_at), a.checked_in_count, localTimestamp(a.created_at)]);
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
  const due = svc.amountDue(db, rsvp);
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

// Check-in lives in routes/checkin.js (shared with door volunteers).

// ---------- News ----------

router.get('/news', (req, res) => {
  const posts = req.app.locals.db.prepare('SELECT * FROM news_posts ORDER BY created_at DESC, id DESC').all();
  res.render('admin/news', { title: 'News', posts });
});

router.post('/news', eventImage, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  const body = String(req.body.body || '').trim().slice(0, 10000);
  if (!title || !body) throw new svc.UserError('Please enter a title and the announcement text.');
  req.app.locals.db.prepare('INSERT INTO news_posts (title, body, title_gu, body_gu, author_id, image_path) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title, body, String(req.body.title_gu || '').trim().slice(0, 200) || null, String(req.body.body_gu || '').trim().slice(0, 10000) || null,
      req.user.id, req.file ? `/uploads/${req.file.filename}` : null);
  req.flash('success', 'Announcement posted. Members see it under News and on their home page.');
  res.redirect('/admin/news');
});

router.post('/news/:id/delete', (req, res) => {
  const post = req.app.locals.db.prepare('SELECT image_path FROM news_posts WHERE id = ?').get(req.params.id);
  removeUpload(req.app.locals.config, post?.image_path);
  req.app.locals.db.prepare('DELETE FROM news_posts WHERE id = ?').run(req.params.id);
  req.flash('success', 'Announcement deleted.');
  res.redirect('/admin/news');
});

// ---------- Gujarat & India news ----------

router.get('/news/feeds', (req, res) => {
  const { db } = req.app.locals;
  const words = newsfeed.filterWords(db);
  const sources = db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM news_items i WHERE i.source_id = s.id) AS item_count
    FROM news_sources s ORDER BY s.enabled DESC, s.name COLLATE NOCASE`).all();
  // Latest stories from every source, including the ones members don't see, so the committee can check the filter.
  const items = db.prepare(`SELECT i.*, s.name AS source_name, s.enabled FROM news_items i JOIN news_sources s ON s.id = i.source_id
    ORDER BY i.published_at DESC, i.id DESC LIMIT 60`).all()
    .map((it) => ({ ...it, filteredBy: newsfeed.filterMatch(it, words) }));
  res.render('admin/news_feeds', { title: 'Gujarat & India news', sources, items, words, topics: newsfeed.TOPICS });
});

function sourceFields(body) {
  const name = String(body.name || '').trim().slice(0, 100);
  const url = String(body.url || '').trim().slice(0, 500);
  if (!name) throw new svc.UserError('Please give the source a name, e.g. "Divya Bhaskar: Gujarat".');
  const problem = newsfeed.feedUrlProblem(url);
  if (problem) throw new svc.UserError(problem);
  return {
    name, url,
    lang: body.lang === 'gu' ? 'gu' : 'en',
    topic: newsfeed.TOPICS.includes(body.topic) ? body.topic : 'India',
  };
}

const checkResult = (req, name, result) => req.flash(result.ok ? 'success' : 'error', result.ok
  ? `${name}: working, ${result.count} headlines found.`
  : `${name}: not working. ${result.error}`);

router.post('/news/feeds', async (req, res) => {
  const { db } = req.app.locals;
  const f = sourceFields(req.body);
  if (db.prepare('SELECT 1 FROM news_sources WHERE url = ?').get(f.url)) throw new svc.UserError('That feed is already on the list.');
  const id = Number(db.prepare('INSERT INTO news_sources (name, url, lang, topic) VALUES (?, ?, ?, ?)').run(f.name, f.url, f.lang, f.topic).lastInsertRowid);
  checkResult(req, f.name, await newsfeed.fetchSource(db, db.prepare('SELECT * FROM news_sources WHERE id = ?').get(id)));
  res.redirect('/admin/news/feeds');
});

router.post('/news/feeds/check-all', async (req, res) => {
  const { db } = req.app.locals;
  await newsfeed.refreshNews(db);
  const failing = db.prepare('SELECT COUNT(*) AS n FROM news_sources WHERE enabled = 1 AND last_error IS NOT NULL').get().n;
  req.flash(failing ? 'error' : 'success', failing ? `Checked all sources. ${failing} not working; see the list below.` : 'Checked all sources: all working.');
  res.redirect('/admin/news/feeds');
});

router.post('/news/feeds/filter', (req, res) => {
  const words = [...new Set(String(req.body.words || '').split(/[\n,]/).map((w) => w.trim()).filter(Boolean))].slice(0, 500);
  setContent(req.app.locals.db, 'news_filter', words);
  req.flash('success', `Filter saved: stories mentioning any of the ${words.length} words are hidden from members.`);
  res.redirect('/admin/news/feeds#filter');
});

router.post('/news/feeds/:id/check', async (req, res) => {
  const { db } = req.app.locals;
  const source = db.prepare('SELECT * FROM news_sources WHERE id = ?').get(req.params.id);
  if (!source) return notFound(res, 'News source');
  checkResult(req, source.name, await newsfeed.fetchSource(db, source));
  res.redirect('/admin/news/feeds');
});

router.post('/news/feeds/:id/edit', (req, res) => {
  const { db } = req.app.locals;
  const f = sourceFields(req.body);
  if (db.prepare('SELECT 1 FROM news_sources WHERE url = ? AND id != ?').get(f.url, req.params.id)) throw new svc.UserError('That feed is already on the list.');
  db.prepare('UPDATE news_sources SET name = ?, url = ?, lang = ?, topic = ?, enabled = ? WHERE id = ?')
    .run(f.name, f.url, f.lang, f.topic, req.body.enabled ? 1 : 0, req.params.id);
  req.flash('success', `${f.name} saved.`);
  res.redirect('/admin/news/feeds');
});

router.post('/news/feeds/:id/delete', (req, res) => {
  req.app.locals.db.prepare('DELETE FROM news_sources WHERE id = ?').run(req.params.id);
  req.flash('success', 'News source removed, with its headlines.');
  res.redirect('/admin/news/feeds');
});

// Hide one story from members (or show it again).
router.post('/news/items/:id/hide', (req, res) => {
  req.app.locals.db.prepare('UPDATE news_items SET hidden = ? WHERE id = ?').run(req.body.hidden === '0' ? 0 : 1, req.params.id);
  req.flash('success', req.body.hidden === '0' ? 'Story shown to members again.' : 'Story hidden from members.');
  res.redirect('/admin/news/feeds#stories');
});

// ---------- Payments & plans ----------

router.get('/payments', (req, res) => {
  const { db } = req.app.locals;
  const kind = ['membership', 'event', 'other'].includes(req.query.kind) ? req.query.kind : '';
  const payments = db.prepare(`
    SELECT p.*, u.first_name, u.last_name, u.email FROM payments p JOIN users u ON u.id = p.user_id
    WHERE p.status = 'paid' AND (? = '' OR p.kind = ? OR (? = 'membership' AND p.kind = 'membership_upgrade'))
    ORDER BY p.paid_at DESC LIMIT 500
  `).all(kind, kind, kind);
  const total = payments.reduce((sum, p) => sum + p.amount_cents, 0);
  // Dues that arrived but weren't applied (e.g. paid twice from two tabs) and were given back.
  const refunds = db.prepare(`SELECT p.*, u.first_name, u.last_name FROM payments p JOIN users u ON u.id = p.user_id
    WHERE p.refunded_at IS NOT NULL ORDER BY p.refunded_at DESC LIMIT 50`).all();
  res.render('admin/payments', { title: 'Payments', payments, total, kind, refunds });
});

router.get('/payments.csv', (req, res) => {
  const { db, money } = req.app.locals;
  const rows = [['Date', 'First name', 'Last name', 'Email', 'Type', 'Description', 'Amount', 'Method', 'Reference']];
  for (const p of db.prepare(`SELECT p.*, u.first_name, u.last_name, u.email FROM payments p JOIN users u ON u.id = p.user_id
                              WHERE p.status = 'paid' ORDER BY p.paid_at DESC`).all()) {
    rows.push([localTimestamp(p.paid_at), p.first_name, p.last_name, p.email, p.kind, p.description, money(p.amount_cents), p.method, p.provider_ref]);
  }
  res.attachment('payments.csv').type('text/csv').send(toCsv(rows));
});

router.get('/plans', (req, res) => {
  const plans = req.app.locals.db.prepare('SELECT * FROM membership_plans ORDER BY active DESC, sort_order, amount_cents').all()
    .map((p) => ({ ...p, coverage: svc.planCoverage(p) }));
  res.render('admin/plans', { title: 'Membership levels', plans });
});

router.post('/plans', (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const amount = parseMoney(req.body.amount);
  const calendarYear = req.body.period === 'calendar' ? 1 : 0;
  const months = calendarYear ? 12 : parseIntInRange(req.body.duration_months, 1, 1200);
  const maxParents = parseIntInRange(req.body.max_parents || 0, 0, 4);
  const minAge = parseIntInRange(req.body.min_age || 0, 0, 120);
  if (!name || Number.isNaN(amount) || !months || maxParents === null || minAge === null) {
    throw new svc.UserError('Enter a name, price and length for the membership level.');
  }
  req.app.locals.db.prepare(`INSERT INTO membership_plans (name, name_gu, description, amount_cents, duration_months, calendar_year,
                               spouse_allowed, children_allowed, max_parents, min_age) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(name, String(req.body.name_gu || '').trim().slice(0, 100) || null, String(req.body.description || '').trim().slice(0, 500) || null, amount, months, calendarYear,
      req.body.spouse_allowed ? 1 : 0, req.body.children_allowed ? 1 : 0, maxParents, minAge);
  req.flash('success', 'Membership level added.');
  res.redirect('/admin/plans');
});

router.post('/plans/:id/toggle', (req, res) => {
  req.app.locals.db.prepare('UPDATE membership_plans SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/admin/plans');
});

module.exports = router;
