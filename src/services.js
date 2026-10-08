const crypto = require('node:crypto');
const { transaction } = require('./db');
const { newToken, nowLocal, today, addMonths } = require('./util');
const { interpolate } = require('./i18n');

// A message for the person using the app. `message` is English text that may contain {placeholders};
// it is translated when shown, with `vars` filled in.
class UserError extends Error {
  constructor(message, vars) {
    super(interpolate(message, vars));
    this.template = message;
    this.vars = vars;
  }
}

// ---------- Members ----------

const PROFILE_FIELDS = [
  'first_name', 'last_name', 'phone', 'address_line1', 'address_line2', 'city', 'state',
  'postal_code', 'native_place', 'date_of_birth', 'occupation',
];

function cleanProfile(body) {
  const profile = {};
  for (const field of PROFILE_FIELDS) {
    profile[field] = String(body[field] ?? '').trim().slice(0, 200) || null;
  }
  if (!profile.first_name || !profile.last_name) {
    throw new UserError('First and last name are required.');
  }
  if (profile.date_of_birth && !/^\d{4}-\d{2}-\d{2}$/.test(profile.date_of_birth)) {
    throw new UserError('Date of birth must be a valid date.');
  }
  return profile;
}

function updateProfile(db, userId, body) {
  const profile = cleanProfile(body);
  const sets = PROFILE_FIELDS.map((f) => `${f} = ?`).join(', ');
  db.prepare(`UPDATE users SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
    .run(...PROFILE_FIELDS.map((f) => profile[f]), userId);
}

// ---------- Membership levels & family coverage ----------

// Relationship choices offered for family members, grouped by what a plan has to cover.
const RELATIONSHIPS = {
  Spouse: 'spouse',
  Son: 'child',
  Daughter: 'child',
  Father: 'parent',
  Mother: 'parent',
  'Father-in-law': 'parent',
  'Mother-in-law': 'parent',
};

function relationshipGroup(relationship) {
  return RELATIONSHIPS[relationship] || 'other';
}

function getHousehold(db, userId) {
  return db.prepare('SELECT * FROM household_members WHERE user_id = ? ORDER BY id').all(userId);
}

function countByGroup(household) {
  const counts = { spouse: 0, child: 0, parent: 0, other: 0 };
  for (const h of household) counts[relationshipGroup(h.relationship)] += 1;
  return counts;
}

// Who a plan covers, as list parts (translated and joined for display), e.g.
// ['you', 'your spouse', 'your unmarried children'].
function planCoverageParts(plan) {
  const parts = ['you'];
  if (plan.spouse_allowed) parts.push('your spouse');
  if (plan.children_allowed) parts.push('your unmarried children');
  if (plan.max_parents) parts.push(plan.max_parents === 2 ? 'one set of parents' : plan.max_parents === 1 ? 'one parent' : `${plan.max_parents} parents`);
  return parts.length === 1 ? ['you only'] : parts;
}

// Plain-language English list, e.g. "you, your spouse and your unmarried children".
function planCoverage(plan) {
  const parts = planCoverageParts(plan);
  return parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

// Returns the reasons a household doesn't fit a plan (empty array = fits).
function planProblems(plan, household) {
  const c = countByGroup(household);
  const problems = [];
  if (c.spouse > (plan.spouse_allowed ? 1 : 0)) problems.push(plan.spouse_allowed ? 'only one spouse can be listed' : 'does not include a spouse');
  if (c.child && !plan.children_allowed) problems.push('does not include children');
  if (c.parent > plan.max_parents) problems.push(plan.max_parents === 1 ? 'includes at most 1 parent' : plan.max_parents ? 'includes at most 2 parents' : 'does not include parents');
  if (c.other) problems.push('family members must be a spouse, child or parent');
  return problems;
}

function ageOn(dateOfBirth, onDate) {
  const [y, m, d] = dateOfBirth.split('-').map(Number);
  const [ty, tm, td] = onDate.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
}

// Why this member can't choose this plan right now (null = eligible), as a translatable
// { template, vars } message.
function planIneligibility(db, plan, user) {
  const vars = { plan: plan.name, age: plan.min_age };
  if (plan.min_age) {
    if (!user.date_of_birth) return { template: 'Add your date of birth to your profile to choose {plan} (age {age}+).', vars };
    if (ageOn(user.date_of_birth, today()) < plan.min_age) return { template: '{plan} is for members aged {age} or older.', vars };
  }
  const problems = planProblems(plan, getHousehold(db, user.id));
  if (problems.length) {
    return { template: "{plan} {problems} — your profile lists family members it doesn't cover.", vars: { ...vars, problems: { list: problems } } };
  }
  return null;
}

// Cheapest available plan that would cover this household (used to suggest an upgrade).
function suggestPlan(db, household) {
  return db.prepare('SELECT * FROM membership_plans WHERE active = 1 ORDER BY amount_cents').all()
    .find((p) => planProblems(p, household).length === 0) || null;
}

// A family login (spouse, child, parent with their own sign-in) belongs to the member who listed
// them; membership, family and coverage are always those of that member's account.
function householdOwnerId(db, userId) {
  return db.prepare('SELECT owner_id FROM users WHERE id = ?').get(userId)?.owner_id || Number(userId);
}

function membershipStatus(db, userId) {
  userId = householdOwnerId(db, userId);
  const now = today();
  const rows = db.prepare(`
    SELECT m.*, p.name AS plan_name FROM memberships m
    LEFT JOIN membership_plans p ON p.id = m.plan_id
    WHERE m.user_id = ? ORDER BY m.end_date DESC, m.id DESC
  `).all(userId);
  if (!rows.length) return { active: false, current: null, plan: null, validUntil: null };
  // The period in effect today (an upgrade adds a newer row for the same period), else the latest.
  const inEffect = rows.filter((r) => r.start_date <= now && r.end_date >= now).sort((a, b) => b.id - a.id)[0];
  const current = inEffect || rows[0];
  const plan = current.plan_id ? db.prepare('SELECT * FROM membership_plans WHERE id = ?').get(current.plan_id) : null;
  return { active: Boolean(inEffect), current, plan, validUntil: rows[0].end_date };
}

function periodEnd(plan, startDate) {
  if (plan.calendar_year) return `${startDate.slice(0, 4)}-12-31`;
  return addMonths(startDate, plan.duration_months);
}

function grantMembership(db, { userId, planId, paymentId }) {
  userId = householdOwnerId(db, userId);
  const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ?').get(planId);
  if (!plan) throw new UserError('Membership plan not found.');
  const { active, validUntil } = membershipStatus(db, userId);
  // Renewals start the day after the paid-up period ends, so members never lose paid time.
  const startDate = active || (validUntil && validUntil >= today()) ? nextDay(validUntil) : today();
  db.prepare(`INSERT INTO memberships (user_id, plan_id, payment_id, start_date, end_date)
              VALUES (?, ?, ?, ?, ?)`).run(userId, planId, paymentId ?? null, startDate, periodEnd(plan, startDate));
}

// Moving up to a bigger level mid-period: same end date, new plan from today.
// The level stays with the member: an upgrade changes this period from today, and any period
// already paid ahead (e.g. next year) moves up too — the upgrade price includes those years.
function upgradeMembership(db, { userId, planId, paymentId }) {
  userId = householdOwnerId(db, userId);
  const { active, current } = membershipStatus(db, userId);
  if (!active) return grantMembership(db, { userId, planId, paymentId });
  db.prepare(`INSERT INTO memberships (user_id, plan_id, payment_id, start_date, end_date)
              VALUES (?, ?, ?, ?, ?)`).run(userId, planId, paymentId ?? null, today(), current.end_date);
  db.prepare(`UPDATE memberships SET plan_id = :plan WHERE user_id = :user AND start_date > :today
              AND plan_id IN (SELECT id FROM membership_plans WHERE amount_cents < (SELECT amount_cents FROM membership_plans WHERE id = :plan))`)
    .run({ plan: planId, user: userId, today: today() });
}

// Periods already paid for that haven't started yet (a renewal paid ahead), with their level's price.
function prepaidPeriods(db, userId) {
  return db.prepare(`SELECT m.*, p.amount_cents AS plan_amount FROM memberships m JOIN membership_plans p ON p.id = m.plan_id
    WHERE m.user_id = ? AND m.start_date > ? ORDER BY m.start_date`).all(householdOwnerId(db, userId), today());
}

/**
 * Adds a family member to a profile. While a membership is active, the family has to fit the
 * level that was paid for; members are told which level to upgrade to. Admins can override.
 */
function addHouseholdMember(db, { userId, name, relationship, birthYear, override = false }) {
  name = String(name || '').trim().slice(0, 120);
  if (!name) throw new UserError('Please enter a name for the family member.');
  if (!(relationship in RELATIONSHIPS)) throw new UserError('Please choose a relationship.');
  const household = [...getHousehold(db, userId), { relationship }];
  const { active, plan } = membershipStatus(db, userId);
  if (active && plan && !override) {
    const problems = planProblems(plan, household);
    if (problems.length) {
      const better = suggestPlan(db, household);
      // "Individual Membership" would read "Your Individual Membership membership".
      const vars = { plan: plan.name.replace(/\s+membership$/i, ''), coverage: { list: planCoverageParts(plan) }, name, better: better?.name };
      throw new UserError(better
        ? "Your {plan} membership covers {coverage}, so {name} can't be added. Upgrade to {better} on the Membership page to add them."
        : "Your {plan} membership covers {coverage}, so {name} can't be added.", vars);
    }
  }
  db.prepare('INSERT INTO household_members (user_id, name, relationship, birth_year) VALUES (?, ?, ?, ?)')
    .run(userId, name, relationship, birthYear ?? null);
  return { name, exceedsPlan: Boolean(active && plan && planProblems(plan, household).length) };
}

/**
 * Everyone in a member's family, by name, as seen by `userId` (the member or one of their family
 * logins). Each person has a key: 'u:<id>' for the member, 'h:<id>' for family on the profile.
 *  - member: covered by the active membership (member price), up to what the level includes
 *  - canRegister: may be put on an RSVP — covered people, plus the signed-in person themselves
 *    (who pays the guest price without a membership)
 */
function familyPeople(db, userId) {
  userId = Number(userId);
  const ownerId = householdOwnerId(db, userId);
  const owner = db.prepare('SELECT id, first_name, last_name FROM users WHERE id = ?').get(ownerId);
  const { active, plan } = membershipStatus(db, ownerId);
  const allowed = {
    spouse: active && plan?.spouse_allowed ? 1 : 0,
    child: active && plan?.children_allowed ? Infinity : 0,
    parent: active && plan ? plan.max_parents : 0,
    other: 0,
  };
  const people = [{
    key: `u:${owner.id}`, name: `${owner.first_name} ${owner.last_name}`, relationship: null,
    self: owner.id === userId, member: active, loginUserId: owner.id,
  }];
  for (const h of getHousehold(db, ownerId)) {
    const group = relationshipGroup(h.relationship);
    const member = allowed[group] > 0;
    if (member) allowed[group] -= 1;
    people.push({ key: `h:${h.id}`, name: h.name, relationship: h.relationship, self: h.login_user_id === userId, member, loginUserId: h.login_user_id });
  }
  return people.map((p) => ({ ...p, canRegister: p.member || p.self }));
}

// Family members the active membership actually covers (0 without an active membership).
function coveredFamily(db, userId) {
  return familyPeople(db, userId).filter((p) => p.member && !p.key.startsWith('u:')).length;
}

// ---------- Family logins ----------

const INVITE_DAYS = 14;

/**
 * A member invites someone on their family list to have their own login. The member shares the
 * private link themselves (WhatsApp, text…); whoever opens it joins as that family member, so the
 * link is unguessable, single-use and expires after INVITE_DAYS. Making a new one replaces the old.
 */
function createFamilyInvite(db, { ownerId, householdId }) {
  const h = db.prepare('SELECT * FROM household_members WHERE id = ? AND user_id = ?').get(householdId, ownerId);
  if (!h) throw new UserError('Family member not found.');
  if (h.login_user_id) throw new UserError('{name} already has their own login.', { name: h.name });
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare(`UPDATE household_members SET invite_token = ?, invite_expires = datetime('now', '+${INVITE_DAYS} days') WHERE id = ?`)
    .run(token, h.id);
  return { name: h.name, token };
}

function cancelFamilyInvite(db, { ownerId, householdId }) {
  db.prepare('UPDATE household_members SET invite_token = NULL, invite_expires = NULL WHERE id = ? AND user_id = ?').run(householdId, ownerId);
}

// The family member an invite link is for (null if the link is unknown, used or expired).
function findFamilyInvite(db, token) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return null;
  return db.prepare(`SELECT h.*, u.first_name AS owner_first, u.last_name AS owner_last FROM household_members h
    JOIN users u ON u.id = h.user_id
    WHERE h.invite_token = ? AND h.invite_expires > datetime('now') AND h.login_user_id IS NULL`).get(token) || null;
}

// Why an existing account can't join a family through an invite (null = it can).
function familyJoinProblem(db, user, invite) {
  if (user.id === invite.user_id) return 'This is your own invite link. Share it with {name} so they can join.';
  if (user.owner_id) return 'Your account is already part of a family.';
  const ownFamily = db.prepare('SELECT 1 FROM household_members WHERE user_id = ?').get(user.id);
  const ownMembership = db.prepare('SELECT 1 FROM memberships WHERE user_id = ?').get(user.id);
  const ownTickets = db.prepare(`SELECT 1 FROM rsvps r JOIN events e ON e.id = r.event_id
    WHERE r.user_id = ? AND r.status != 'cancelled' AND e.starts_at >= ?`).get(user.id, today());
  if (ownFamily || ownMembership || ownTickets) {
    return 'Your account has its own membership, family list or event tickets, so it can’t be joined to another family here. Please ask a committee member.';
  }
  return null;
}

// Uses an invite: links the account to the family and retires the link.
function acceptFamilyInvite(db, { token, userId }) {
  return transaction(db, () => {
    const invite = findFamilyInvite(db, token);
    if (!invite) throw new UserError('This invite link is no longer valid. Please ask your family member for a new one.');
    db.prepare('UPDATE users SET owner_id = ? WHERE id = ?').run(invite.user_id, userId);
    db.prepare('UPDATE household_members SET login_user_id = ?, invite_token = NULL, invite_expires = NULL WHERE id = ?').run(userId, invite.id);
    return invite;
  });
}

// Removing someone from the family also ends their family login's link (their account stays).
function removeHouseholdMember(db, { ownerId, householdId }) {
  const h = db.prepare('SELECT * FROM household_members WHERE id = ? AND user_id = ?').get(householdId, ownerId);
  if (!h) return;
  if (h.login_user_id) db.prepare('UPDATE users SET owner_id = NULL WHERE id = ? AND owner_id = ?').run(h.login_user_id, ownerId);
  db.prepare('DELETE FROM household_members WHERE id = ?').run(h.id);
}

// Accounts that share a family: the member and their family logins.
function familyUserIds(db, userId) {
  const ownerId = householdOwnerId(db, userId);
  return [ownerId, ...db.prepare('SELECT id FROM users WHERE owner_id = ?').all(ownerId).map((u) => u.id)];
}

function nextDay(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// ---------- Events & RSVPs ----------

function getEvent(db, eventId) {
  return db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
}

// Seats held by confirmed RSVPs and by RSVPs waiting for payment (waitlisted ones hold none).
function reservedSeats(db, eventId, excludeRsvpId = 0) {
  return db.prepare(`SELECT COALESCE(SUM(party_size), 0) AS n FROM rsvps
                     WHERE event_id = ? AND status IN ('confirmed', 'pending_payment') AND id != ?`)
    .get(eventId, excludeRsvpId).n;
}

function eventStats(db, eventId) {
  return db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed_parties,
      COALESCE(SUM(party_size) FILTER (WHERE status = 'confirmed'), 0) AS confirmed_people,
      COALESCE(SUM(guest_count) FILTER (WHERE status = 'confirmed'), 0) AS confirmed_guests,
      COUNT(*) FILTER (WHERE status = 'pending_payment') AS pending_parties,
      COALESCE(SUM(party_size) FILTER (WHERE status = 'pending_payment'), 0) AS pending_people,
      COUNT(*) FILTER (WHERE status = 'waitlisted') AS waitlisted_parties,
      COALESCE(SUM(party_size) FILTER (WHERE status = 'waitlisted'), 0) AS waitlisted_people,
      COUNT(*) FILTER (WHERE checked_in_at IS NOT NULL) AS checked_in_parties,
      COALESCE(SUM(checked_in_count), 0) AS checked_in_people
    FROM rsvps WHERE event_id = ?
  `).get(eventId);
}

function eventRevenue(db, eventId) {
  return db.prepare(`SELECT COALESCE(SUM(p.amount_cents), 0) AS cents FROM payments p
                     JOIN rsvps r ON r.id = p.reference_id
                     WHERE p.kind = 'event' AND p.status = 'paid' AND r.event_id = ?`)
    .get(eventId).cents;
}

// Event fees are non-refundable: whatever was paid stays as credit on the RSVP, so a member
// who lowers their guest count and later raises it again is not charged twice.
function paidForRsvp(db, rsvpId) {
  return db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM payments
                     WHERE kind = 'event' AND reference_id = ? AND status = 'paid'`)
    .get(rsvpId).cents;
}

// People already on another active RSVP for this event: person key → name of the ticket holder.
function takenPeople(db, eventId, excludeRsvpId = 0) {
  const rows = db.prepare(`SELECT a.person, u.first_name, u.last_name FROM rsvp_attendees a
    JOIN rsvps r ON r.id = a.rsvp_id JOIN users u ON u.id = r.user_id
    WHERE a.event_id = ? AND r.status != 'cancelled' AND r.id != ?`).all(eventId, excludeRsvpId);
  return new Map(rows.map((r) => [r.person, `${r.first_name} ${r.last_name}`]));
}

function ownRsvp(db, eventId, userId) {
  return db.prepare('SELECT * FROM rsvps WHERE event_id = ? AND user_id = ?').get(eventId, userId);
}

/**
 * The family as offered on an RSVP form: each person with `taken` (the ticket holder's name if
 * they're already on another family ticket for this event) and `chosen` (on this member's RSVP).
 */
function eventPeople(db, event, userId) {
  const mine = ownRsvp(db, event.id, userId);
  const active = mine && mine.status !== 'cancelled';
  const taken = takenPeople(db, event.id, mine?.id ?? 0);
  const chosen = new Set(active ? rsvpAttendees(db, mine.id).map((a) => a.person) : []);
  return familyPeople(db, userId).map((p) => ({ ...p, taken: taken.get(p.key) || null, chosen: chosen.has(p.key) }));
}

function rsvpAttendees(db, rsvpId) {
  return db.prepare('SELECT * FROM rsvp_attendees WHERE rsvp_id = ? ORDER BY id').all(rsvpId);
}

// Names on a ticket, for display: family by name, then "+ 2 guests". Older RSVPs have no names.
function attendeeNames(db, rsvp) {
  return rsvpAttendees(db, rsvp.id).map((a) => a.name);
}

// A member can register themselves plus the family on their profile that their membership level
// covers (and who aren't on another family ticket), never more than the event's per-RSVP limit.
function maxPartySize(db, event, userId) {
  const free = eventPeople(db, event, userId).filter((p) => p.canRegister && !p.taken).length;
  return Math.max(1, Math.min(event.max_party_size, free));
}

// Swaps in a new QR code. The old one stops working immediately (check-in matches on the
// current token only) and is remembered so a scan of it can be explained at the door.
function replaceQrToken(db, rsvp, reason) {
  db.prepare('INSERT OR IGNORE INTO retired_qr_tokens (token, rsvp_id, reason) VALUES (?, ?, ?)')
    .run(rsvp.qr_token, rsvp.id, reason);
  const token = newToken();
  db.prepare(`UPDATE rsvps SET qr_token = ?, updated_at = datetime('now') WHERE id = ?`).run(token, rsvp.id);
  return token;
}

function amountDue(db, rsvp) {
  return Math.max(0, rsvp.total_cents - paidForRsvp(db, rsvp.id));
}

function rsvpWindowOpen(event) {
  const now = nowLocal();
  if (event.status !== 'published') return false;
  if (event.starts_at <= now) return false;
  if (event.rsvp_deadline && event.rsvp_deadline < now) return false;
  return true;
}

// ---------- Event pricing ----------

function earlyBirdActive(event, at = nowLocal()) {
  return event.early_fee_cents !== null && Boolean(event.early_until) && at <= event.early_until;
}

// Per-person price for the member and their covered family (early-bird price while it lasts).
function memberPrice(event) {
  return earlyBirdActive(event) ? event.early_fee_cents : event.fee_cents;
}

function eventQuestions(event) {
  try {
    const q = JSON.parse(event.questions || '[]');
    return Array.isArray(q) ? q : [];
  } catch {
    return [];
  }
}

// Turns the admin's "one question per line" text into structured questions.
// "*" at the start = required; "Question: a, b, c" = pick one of a/b/c.
function parseQuestions(text) {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 10).map((line) => {
    const required = line.startsWith('*');
    const body = line.replace(/^\*\s*/, '');
    const colon = body.indexOf(':');
    const options = colon > 0 ? body.slice(colon + 1).split(',').map((o) => o.trim()).filter(Boolean) : [];
    const label = (options.length ? body.slice(0, colon) : body).trim().slice(0, 200);
    return { label, required, options };
  });
}

function questionsToText(questions) {
  return questions.map((q) => `${q.required ? '*' : ''}${q.label}${q.options.length ? `: ${q.options.join(', ')}` : ''}`).join('\n');
}

function collectAnswers(event, body) {
  return eventQuestions(event).map((q, i) => {
    const answer = String(body[`q_${i}`] ?? '').trim().slice(0, 300);
    if (q.required && !answer) throw new UserError('Please answer: {question}', { question: q.label });
    if (answer && q.options.length && !q.options.includes(answer)) throw new UserError('Please choose an option for: {question}', { question: q.label });
    return { label: q.label, answer };
  });
}

function findCoupon(db, code, event, excludeRsvpId = 0) {
  const coupon = db.prepare('SELECT * FROM coupons WHERE code = ? AND active = 1').get(String(code).trim());
  if (!coupon || (coupon.event_id && coupon.event_id !== event.id)) throw new UserError('That coupon code is not valid for this event.');
  if (coupon.expires_at && coupon.expires_at < today()) throw new UserError('That coupon code has expired.');
  if (coupon.max_uses) {
    const used = db.prepare(`SELECT COUNT(*) AS n FROM rsvps WHERE coupon_code = ? COLLATE NOCASE
                             AND status != 'cancelled' AND id != ?`).get(coupon.code, excludeRsvpId).n;
    if (used >= coupon.max_uses) throw new UserError('That coupon code has been fully used.');
  }
  return coupon;
}

/**
 * Price of an RSVP: family covered by the membership pay the member price; guests (and someone
 * without an active membership) pay the guest price. A coupon then comes off the total.
 */
function priceRsvp(db, { event, people, guests, couponCode, excludeRsvpId = 0 }) {
  const mPrice = memberPrice(event);
  const gPrice = event.guest_fee_cents ?? event.fee_cents;
  const subtotal = people.reduce((sum, p) => sum + (p.member ? mPrice : gPrice), 0) + guests * gPrice;
  let discount = 0;
  let coupon = null;
  if (couponCode && subtotal > 0) {
    coupon = findCoupon(db, couponCode, event, excludeRsvpId);
    discount = coupon.percent_off ? Math.round(subtotal * coupon.percent_off / 100) : Math.min(subtotal, coupon.amount_off_cents);
  }
  return { subtotal, discount, total: subtotal - discount, couponCode: coupon?.code ?? null };
}

/**
 * Creates or updates a member's RSVP. Returns { rsvp, amountDue, qrReplaced, waitlisted }.
 * Free (or fully paid) RSVPs are confirmed at once; otherwise they wait in pending_payment.
 * If the event is full and the member asked for it, the RSVP goes on the waitlist instead.
 */
// Which family members an RSVP is for: chosen by name (`people`, person keys), or — from a form
// that only asks how many — the member first, then covered family in profile order.
function chooseAttendees(db, { event, userId, people, partySize, existingId }) {
  const everyone = familyPeople(db, userId);
  const taken = takenPeople(db, event.id, existingId);
  let chosen;
  if (people) {
    const keys = [...new Set([].concat(people).map(String))];
    chosen = keys.map((key) => everyone.find((p) => p.key === key));
    if (chosen.some((p) => !p)) throw new UserError('Please choose people from your family list.');
    for (const p of chosen) {
      if (taken.has(p.key)) throw new UserError("{name} is already registered for this event on {holder}'s ticket.", { name: p.name, holder: taken.get(p.key) });
      if (!p.canRegister) throw new UserError("{name} isn't covered by your membership level, so they can't be registered.", { name: p.name });
    }
    if (!chosen.length) throw new UserError('Please choose who is coming.');
    if (chosen.length > event.max_party_size) throw new UserError('You can register up to {n} people on one RSVP for this event.', { n: event.max_party_size });
  } else {
    const free = everyone.filter((p) => p.canRegister && !taken.has(p.key));
    const ordered = [...free.filter((p) => p.self), ...free.filter((p) => !p.self)];
    const maxParty = Math.max(1, Math.min(event.max_party_size, ordered.length));
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > maxParty || !ordered.length) {
      throw new UserError(maxParty === 1
        ? 'You can register 1 person. Family members listed on your profile and covered by your membership level can come with you.'
        : 'Number of people must be between 1 and {n} (you plus the family members covered by your membership).', { n: maxParty });
    }
    chosen = ordered.slice(0, partySize);
  }
  return chosen;
}

function upsertRsvp(db, {
  eventId, userId, people = null, partySize, guests = 0, couponCode = '', body = {}, joinWaitlist = false, keepAnswers = false,
}) {
  return transaction(db, () => {
    const event = getEvent(db, eventId);
    if (!event) throw new UserError('Event not found.');
    if (!rsvpWindowOpen(event)) throw new UserError('RSVPs are closed for this event.');
    if (event.members_only && !membershipStatus(db, userId).active) {
      throw new UserError('This event is for members with an active membership.');
    }
    const existing = ownRsvp(db, eventId, userId);
    if (existing?.checked_in_at) throw new UserError('You have already checked in to this event.');
    const chosen = chooseAttendees(db, { event, userId, people, partySize, existingId: existing?.id ?? 0 });
    guests = Number(guests) || 0;
    if (!Number.isInteger(guests) || guests < 0) throw new UserError('Number of guests looks incorrect.');
    if (guests > 0 && (event.guest_fee_cents === null || event.members_only)) throw new UserError('This event does not allow guests.');
    if (guests > event.max_guests) throw new UserError(event.max_guests === 1 ? 'You can bring up to 1 guest to this event.' : 'You can bring up to {n} guests to this event.', { n: event.max_guests });
    // Changing who's coming from My tickets keeps the answers given when registering.
    const active = existing && existing.status !== 'cancelled';
    const answers = keepAnswers && active ? existing.answers : JSON.stringify(collectAnswers(event, body));
    const total = chosen.length + guests;
    const keys = chosen.map((p) => p.key).sort().join();
    const oldKeys = active ? rsvpAttendees(db, existing.id).map((a) => a.person).sort().join() : '';
    const peopleChanged = Boolean(oldKeys) && oldKeys !== keys; // older RSVPs without names: compare head counts only

    const reuseCoupon = !couponCode && active ? existing.coupon_code : null;
    const price = priceRsvp(db, {
      event, people: chosen, guests, couponCode: couponCode || reuseCoupon, excludeRsvpId: existing?.id ?? 0,
    });
    const saveAttendees = (rsvpId) => {
      db.prepare('DELETE FROM rsvp_attendees WHERE rsvp_id = ?').run(rsvpId);
      const add = db.prepare('INSERT INTO rsvp_attendees (rsvp_id, event_id, person, name, relationship) VALUES (?, ?, ?, ?, ?)');
      for (const p of chosen) add.run(rsvpId, eventId, p.key, p.name, p.relationship);
    };

    let waitlisted = false;
    if (event.capacity) {
      const taken = reservedSeats(db, eventId, existing?.id ?? 0);
      if (taken + total > event.capacity) {
        if (!joinWaitlist && existing?.status !== 'waitlisted') {
          const left = Math.max(0, event.capacity - taken);
          throw new UserError(left === 1 ? 'Sorry, only 1 spot left for this event. You can join the waitlist instead.' : 'Sorry, only {n} spots left for this event. You can join the waitlist instead.', { n: left });
        }
        waitlisted = true;
      }
    }

    const sameRequest = active && existing.party_size === total && !peopleChanged
      && existing.guest_count === guests && (existing.coupon_code || null) === price.couponCode;
    if (sameRequest && (existing.status !== 'waitlisted' || waitlisted)) {
      db.prepare(`UPDATE rsvps SET answers = ?, updated_at = datetime('now') WHERE id = ?`).run(answers, existing.id);
      saveAttendees(existing.id);
      return { rsvp: { ...existing, answers }, amountDue: amountDue(db, existing), qrReplaced: false, waitlisted: existing.status === 'waitlisted' };
    }

    let rsvpId;
    let qrReplaced = false;
    if (existing) {
      // Any change in who is coming (or re-opening a cancelled RSVP) issues a new QR code,
      // so a ticket showing the old people can never be scanned.
      const hadTicket = ['confirmed', 'pending_payment'].includes(existing.status);
      const changed = existing.party_size !== total || existing.guest_count !== guests || peopleChanged;
      if (existing.status === 'cancelled' || changed) {
        replaceQrToken(db, existing, existing.status === 'cancelled' ? 'rsvp reopened'
          : `people changed ${existing.party_size} → ${total}`);
      }
      qrReplaced = hadTicket && changed;
      db.prepare(`UPDATE rsvps SET party_size = ?, guest_count = ?, total_cents = ?, discount_cents = ?, coupon_code = ?,
                  answers = ?, status = ?, updated_at = datetime('now') WHERE id = ?`)
        .run(total, guests, price.total, price.discount, price.couponCode, answers,
          waitlisted ? 'waitlisted' : 'pending_payment', existing.id);
      rsvpId = existing.id;
    } else {
      rsvpId = Number(db.prepare(`INSERT INTO rsvps (event_id, user_id, party_size, guest_count, total_cents, discount_cents,
                                  coupon_code, answers, status, qr_token) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(eventId, userId, total, guests, price.total, price.discount, price.couponCode, answers,
          waitlisted ? 'waitlisted' : 'pending_payment', newToken()).lastInsertRowid);
    }
    saveAttendees(rsvpId);
    // Any checkout started for the old request is now stale.
    db.prepare(`UPDATE payments SET status = 'cancelled' WHERE kind = 'event'
                AND reference_id = ? AND status = 'pending'`).run(rsvpId);

    const rsvp = db.prepare('SELECT * FROM rsvps WHERE id = ?').get(rsvpId);
    const due = waitlisted ? 0 : amountDue(db, rsvp);
    if (!waitlisted && due === 0) {
      db.prepare(`UPDATE rsvps SET status = 'confirmed' WHERE id = ?`).run(rsvpId);
      rsvp.status = 'confirmed';
    }
    // Fewer people than before may have freed seats for the waitlist.
    if (existing && existing.party_size > total) promoteWaitlist(db, eventId);
    return { rsvp, amountDue: due, qrReplaced, waitlisted };
  });
}

/**
 * Moves waitlisted RSVPs (first come, first served) into the event while seats are free.
 * Free ones are confirmed straight away; paid ones then wait for payment.
 * Returns the RSVP ids that were promoted.
 */
function promoteWaitlist(db, eventId) {
  const event = getEvent(db, eventId);
  const waiting = db.prepare(`SELECT * FROM rsvps WHERE event_id = ? AND status = 'waitlisted' ORDER BY created_at, id`).all(eventId);
  const promoted = [];
  let taken = reservedSeats(db, eventId);
  for (const r of waiting) {
    if (event.capacity && taken + r.party_size > event.capacity) continue;
    const status = amountDue(db, r) === 0 ? 'confirmed' : 'pending_payment';
    db.prepare(`UPDATE rsvps SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, r.id);
    taken += r.party_size;
    promoted.push(r.id);
  }
  return promoted;
}

function cancelRsvp(db, { eventId, userId }) {
  return transaction(db, () => {
    const rsvp = db.prepare('SELECT * FROM rsvps WHERE event_id = ? AND user_id = ?').get(eventId, userId);
    if (!rsvp || rsvp.status === 'cancelled') throw new UserError('You do not have an RSVP for this event.');
    if (rsvp.checked_in_at) throw new UserError('This RSVP has already been checked in.');
    db.prepare(`UPDATE rsvps SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(rsvp.id);
    db.prepare(`UPDATE payments SET status = 'cancelled' WHERE kind = 'event'
                AND reference_id = ? AND status = 'pending'`).run(rsvp.id);
    promoteWaitlist(db, eventId);
    return { paidCents: paidForRsvp(db, rsvp.id) };
  });
}

function confirmRsvpIfPaid(db, rsvpId) {
  const rsvp = db.prepare('SELECT * FROM rsvps WHERE id = ?').get(rsvpId);
  if (!rsvp || rsvp.status !== 'pending_payment') return;
  if (amountDue(db, rsvp) === 0) {
    db.prepare(`UPDATE rsvps SET status = 'confirmed', updated_at = datetime('now') WHERE id = ?`).run(rsvpId);
  }
}

// ---------- Check-in ----------

function findRsvpByToken(db, token) {
  return db.prepare(`
    SELECT r.*, e.title AS event_title, e.starts_at, e.fee_cents,
           u.first_name, u.last_name, u.email, u.phone,
           a.first_name AS checker_first, a.last_name AS checker_last
    FROM rsvps r
    JOIN events e ON e.id = r.event_id
    JOIN users u ON u.id = r.user_id
    LEFT JOIN users a ON a.id = r.checked_in_by
    WHERE r.qr_token = ?
  `).get(String(token));
}

/**
 * Checks in a QR code exactly once. The conditional UPDATE makes this safe even if two
 * volunteers scan the same code at the same moment: only one of them succeeds.
 */
function findRetiredToken(db, token) {
  return db.prepare(`
    SELECT t.*, r.party_size, r.status, u.first_name, u.last_name, e.title AS event_title
    FROM retired_qr_tokens t JOIN rsvps r ON r.id = t.rsvp_id
    JOIN users u ON u.id = r.user_id JOIN events e ON e.id = r.event_id
    WHERE t.token = ?
  `).get(String(token));
}

function checkIn(db, { token, guests, adminId }) {
  const rsvp = findRsvpByToken(db, token);
  if (!rsvp && findRetiredToken(db, token)) {
    throw new UserError('This QR code was replaced by a newer one. Ask the member to open My tickets and show the latest code.');
  }
  if (!rsvp) throw new UserError('This QR code is not valid.');
  if (rsvp.status === 'cancelled') throw new UserError('This RSVP was cancelled.');
  if (rsvp.status === 'pending_payment') throw new UserError('Payment is still outstanding for this RSVP.');
  if (rsvp.status === 'waitlisted') throw new UserError('This RSVP is on the waitlist and has no seat yet.');
  if (!Number.isInteger(guests) || guests < 1 || guests > rsvp.party_size) {
    throw new UserError('Guests arriving must be between 1 and {n}.', { n: rsvp.party_size });
  }
  const result = db.prepare(`
    UPDATE rsvps SET checked_in_at = datetime('now'), checked_in_by = ?, checked_in_count = ?
    WHERE qr_token = ? AND status = 'confirmed' AND checked_in_at IS NULL
  `).run(adminId, guests, String(token));
  if (result.changes === 0) throw new UserError('This QR code has already been used.');
  return findRsvpByToken(db, token);
}

// ---------- Payments ----------

function createPayment(db, { userId, kind, referenceId, description, amountCents, note = null }) {
  const id = db.prepare(`INSERT INTO payments (user_id, kind, reference_id, description, amount_cents, note)
                         VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId, kind, referenceId ?? null, description, amountCents, note).lastInsertRowid;
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
}

function createEventPayment(db, { rsvpId, userId }) {
  const rsvp = db.prepare('SELECT * FROM rsvps WHERE id = ? AND user_id = ?').get(rsvpId, userId);
  if (!rsvp || rsvp.status !== 'pending_payment') throw new UserError('Nothing to pay for this RSVP.');
  const event = getEvent(db, rsvp.event_id);
  const due = amountDue(db, rsvp);
  if (due === 0) throw new UserError('Nothing to pay for this RSVP.');
  db.prepare(`UPDATE payments SET status = 'cancelled' WHERE kind = 'event'
              AND reference_id = ? AND status = 'pending'`).run(rsvp.id);
  return createPayment(db, {
    userId, kind: 'event', referenceId: rsvp.id, amountCents: due,
    description: `${event.title} — ${rsvp.party_size} ${rsvp.party_size === 1 ? 'person' : 'people'}`,
  });
}

// What a member would pay for a plan: the price difference when upgrading mid-period,
// otherwise the full price (a new membership, or a renewal for the next period).
/**
 * Dues can be paid at most one year ahead (fees may change for later years): a member can pay for
 * next year, but once they're paid up more than 12 months out, renewing waits. Returns the date
 * renewal opens again, or null if they can renew now. With calendar-year levels, someone paid
 * through Dec 31 next year can renew again from Jan 1.
 */
function renewalOpensOn(db, userId) {
  const { validUntil } = membershipStatus(db, userId);
  if (!validUntil || validUntil <= addMonths(today(), 12)) return null;
  return nextDay(addMonths(validUntil, -12));
}

function membershipQuote(db, plan, userId) {
  const { active, plan: currentPlan, validUntil } = membershipStatus(db, userId);
  if (active && currentPlan && plan.id !== currentPlan.id && plan.amount_cents > currentPlan.amount_cents) {
    // This year's difference, plus the difference for any year already paid ahead at a lower level.
    const prepaid = prepaidPeriods(db, userId).filter((m) => m.plan_amount < plan.amount_cents);
    return {
      kind: 'membership_upgrade',
      amountCents: plan.amount_cents - currentPlan.amount_cents + prepaid.reduce((sum, m) => sum + plan.amount_cents - m.plan_amount, 0),
      prepaidYears: prepaid.map((m) => m.start_date.slice(0, 4)),
    };
  }
  const opensOn = renewalOpensOn(db, userId);
  return { kind: 'membership', amountCents: plan.amount_cents, opensOn, paidThrough: opensOn ? validUntil : null };
}

// Recording or paying dues that would go more than a year ahead.
function assertCanRenew(db, userId) {
  const opensOn = renewalOpensOn(db, userId);
  if (opensOn) {
    throw new UserError('Membership is already paid through {date}. Dues can be paid at most one year ahead, so renewal opens on {opens}.', {
      date: { date: membershipStatus(db, userId).validUntil }, opens: { date: opensOn },
    });
  }
}

function createMembershipPayment(db, { planId, user }) {
  const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ? AND active = 1').get(planId);
  if (!plan) throw new UserError('Please choose a membership level.');
  const reason = planIneligibility(db, plan, user);
  if (reason) throw new UserError(reason.template, reason.vars);
  const { kind, amountCents } = membershipQuote(db, plan, user.id);
  if (kind === 'membership') assertCanRenew(db, user.id);
  return transaction(db, () => {
    // Only one dues checkout can be open per family: starting a new one cancels the others, so a
    // second browser tab can't be used to pay for another year. Their Stripe pages get closed too.
    const ids = familyUserIds(db, user.id);
    const marks = ids.map(() => '?').join(',');
    const staleCheckouts = db.prepare(`SELECT provider_ref FROM payments WHERE status = 'pending'
      AND kind IN ('membership', 'membership_upgrade') AND user_id IN (${marks})`).all(...ids).map((p) => p.provider_ref);
    db.prepare(`UPDATE payments SET status = 'cancelled' WHERE status = 'pending'
      AND kind IN ('membership', 'membership_upgrade') AND user_id IN (${marks})`).run(...ids);
    if (amountCents === 0) {
      (kind === 'membership_upgrade' ? upgradeMembership : grantMembership)(db, { userId: user.id, planId });
      return { payment: null, staleCheckouts };
    }
    const payment = createPayment(db, {
      userId: user.id, kind, referenceId: plan.id, amountCents,
      description: kind === 'membership_upgrade' ? `Membership upgrade — ${plan.name}` : `Membership — ${plan.name}`,
    });
    return { payment, staleCheckouts };
  });
}

// Final check when dues money actually arrives (another tab or device may have paid first):
// dues that would go more than a year ahead, or an upgrade to a level already held, are refused.
function duesProblem(db, payment) {
  if (payment.kind === 'membership') {
    return renewalOpensOn(db, payment.user_id) ? 'membership was already paid one year ahead' : null;
  }
  if (payment.kind === 'membership_upgrade') {
    // Still an upgrade, at the price that was paid (another payment, e.g. a renewal in another tab,
    // or a fee change may have happened in between).
    const target = db.prepare('SELECT * FROM membership_plans WHERE id = ?').get(payment.reference_id);
    const quote = target && membershipQuote(db, target, payment.user_id);
    if (!quote || quote.kind !== 'membership_upgrade') return 'the upgrade no longer applies';
    if (quote.amountCents !== payment.amount_cents) return 'the upgrade price changed before payment arrived';
  }
  return null;
}

// ---------- Donations ----------

function campaignProgress(db, campaignId) {
  return db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(DISTINCT user_id) AS donors FROM payments
                     WHERE kind = 'donation' AND status = 'paid' AND reference_id = ?`).get(campaignId);
}

function createDonationPayment(db, { userId, campaignId, amountCents, note }) {
  if (!Number.isInteger(amountCents) || amountCents < 100) throw new UserError('Please enter a donation of at least $1.');
  if (amountCents > 100000000) throw new UserError('For gifts this large, please contact the committee.');
  let campaign = null;
  if (campaignId) {
    campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND active = 1').get(campaignId);
    if (!campaign) throw new UserError('Please choose a fund to give to.');
  }
  return createPayment(db, {
    userId, kind: 'donation', referenceId: campaign?.id ?? null, amountCents,
    description: `Donation — ${campaign ? campaign.title : 'General fund'}`,
    note: String(note || '').trim().slice(0, 300) || null,
  });
}

/**
 * Marks a payment as paid and applies its effect (membership granted / RSVP confirmed).
 * Idempotent: Stripe may deliver both a redirect and a webhook for the same payment.
 * A 'cancelled' payment is still honoured if money actually arrived for it — except dues that
 * would break the one-year-ahead rule: those are not applied and come back as 'refund', and the
 * caller gives the money back (see settlePayment in routes/pay.js).
 * Returns 'applied', 'refund', or false if this payment was already handled.
 */
function markPaymentPaid(db, paymentId, { method, providerRef = null, recordedBy = null }) {
  return transaction(db, () => {
    const before = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!before || before.status === 'paid' || before.refunded_at) return false;
    const problem = duesProblem(db, before);
    if (problem) {
      db.prepare(`UPDATE payments SET status = 'cancelled', method = ?, provider_ref = COALESCE(?, provider_ref), recorded_by = ?,
                  refunded_at = datetime('now'), note = ? WHERE id = ?`)
        .run(method, providerRef, recordedBy, `Not applied and refunded: ${problem}.`, paymentId);
      return 'refund';
    }
    db.prepare(`
      UPDATE payments SET status = 'paid', method = ?, provider_ref = COALESCE(?, provider_ref),
             recorded_by = ?, paid_at = datetime('now')
      WHERE id = ?
    `).run(method, providerRef, recordedBy, paymentId);
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (payment.kind === 'membership') {
      grantMembership(db, { userId: payment.user_id, planId: payment.reference_id, paymentId });
    } else if (payment.kind === 'membership_upgrade') {
      upgradeMembership(db, { userId: payment.user_id, planId: payment.reference_id, paymentId });
    } else if (payment.kind === 'event') {
      confirmRsvpIfPaid(db, payment.reference_id);
    }
    return 'applied';
  });
}

// ---------- Celebrations ----------

const MONTH_DAY_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

// Birthdays and wedding anniversaries members chose to share, in the next `days` days (today first).
// Only the month and day are used: members never see a year or an age.
function celebrations(db, { from = today(), days = 7 } = {}) {
  const start = new Date(`${from}T12:00:00Z`);
  const upcoming = (monthDay) => {
    if (!MONTH_DAY_RE.test(monthDay || '')) return null;
    for (let d = 0; d < days; d++) {
      const date = new Date(start.getTime() + d * 86400000);
      const md = date.toISOString().slice(5, 10);
      const leapDayInCommonYear = monthDay === '02-29' && md === '02-28' && new Date(Date.UTC(date.getUTCFullYear(), 1, 29)).getUTCMonth() !== 1;
      if (md === monthDay || leapDayInCommonYear) return { date: date.toISOString().slice(0, 10), inDays: d };
    }
    return null;
  };
  // Signed-up members, or contacts with a membership (the same people the member directory lists).
  const active = `(u.contact_type = 'member' AND (u.password_hash IS NOT NULL OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = u.id)))`;
  const list = [];
  for (const u of db.prepare(`SELECT first_name, last_name, date_of_birth FROM users u WHERE share_birthday = 1 AND ${active}`).all()) {
    const when = upcoming(u.date_of_birth?.slice(5, 10));
    if (when) list.push({ kind: 'birthday', name: `${u.first_name} ${u.last_name}`, ...when });
  }
  for (const u of db.prepare(`SELECT u.first_name, u.last_name, u.anniversary,
      (SELECT h.name FROM household_members h WHERE h.user_id = u.id AND h.relationship = 'Spouse' ORDER BY h.id LIMIT 1) AS spouse
      FROM users u WHERE share_anniversary = 1 AND ${active}`).all()) {
    const when = upcoming(u.anniversary?.slice(5, 10));
    if (!when) continue;
    const spouseFirst = u.spouse ? u.spouse.trim().split(/\s+/)[0] : '';
    list.push({ kind: 'anniversary', name: spouseFirst ? `${u.first_name} & ${spouseFirst} ${u.last_name}` : `${u.first_name} ${u.last_name}`, ...when });
  }
  // Family members without their own login (those with a login share from their own profile).
  for (const h of db.prepare(`SELECT h.name, h.birthday, u.last_name FROM household_members h JOIN users u ON u.id = h.user_id
      WHERE h.share_birthday = 1 AND h.login_user_id IS NULL AND ${active}`).all()) {
    const when = upcoming(h.birthday);
    if (when) list.push({ kind: 'birthday', name: h.name.includes(' ') ? h.name : `${h.name} ${h.last_name}`, ...when });
  }
  return list.sort((a, b) => a.inDays - b.inDays || a.name.localeCompare(b.name));
}

// Saves the member's Celebrations choices: their birthday and anniversary, and their family members' birthdays.
function updateCelebrations(db, userId, body) {
  const anniversary = String(body.anniversary || '').trim();
  if (anniversary && !/^\d{4}-\d{2}-\d{2}$/.test(anniversary)) throw new UserError('Please enter the anniversary as a full date.');
  const user = db.prepare('SELECT date_of_birth, owner_id FROM users WHERE id = ?').get(userId);
  const shareBirthday = body.share_birthday && user.date_of_birth ? 1 : 0;
  db.prepare('UPDATE users SET share_birthday = ?, anniversary = ?, share_anniversary = ? WHERE id = ?')
    .run(shareBirthday, anniversary || null, anniversary && body.share_anniversary ? 1 : 0, userId);
  if (user.owner_id) return;
  for (const h of db.prepare('SELECT id FROM household_members WHERE user_id = ? AND login_user_id IS NULL').all(userId)) {
    const month = String(body[`birthday_month_${h.id}`] || '').padStart(2, '0');
    const day = String(body[`birthday_day_${h.id}`] || '').padStart(2, '0');
    const birthday = MONTH_DAY_RE.test(`${month}-${day}`) ? `${month}-${day}` : null;
    db.prepare('UPDATE household_members SET birthday = ?, share_birthday = ? WHERE id = ?')
      .run(birthday, birthday && body[`share_birthday_${h.id}`] ? 1 : 0, h.id);
  }
}

module.exports = {
  celebrations, updateCelebrations,
  UserError, PROFILE_FIELDS, updateProfile, cleanProfile, membershipStatus, grantMembership, upgradeMembership,
  RELATIONSHIPS, getHousehold, planCoverage, planCoverageParts, planProblems, planIneligibility, suggestPlan, addHouseholdMember,
  coveredFamily, membershipQuote, renewalOpensOn, assertCanRenew, periodEnd, householdOwnerId, familyPeople, familyUserIds,
  createFamilyInvite, cancelFamilyInvite, findFamilyInvite, familyJoinProblem, acceptFamilyInvite, removeHouseholdMember,
  eventPeople, rsvpAttendees, attendeeNames, takenPeople,
  getEvent, eventStats, eventRevenue, amountDue, paidForRsvp, rsvpWindowOpen, reservedSeats, promoteWaitlist,
  earlyBirdActive, memberPrice, eventQuestions, parseQuestions, questionsToText, priceRsvp,
  maxPartySize, upsertRsvp, cancelRsvp, findRsvpByToken, findRetiredToken, checkIn,
  createPayment, createEventPayment, createMembershipPayment, markPaymentPaid, campaignProgress, createDonationPayment,
};
