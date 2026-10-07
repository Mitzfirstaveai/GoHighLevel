const { transaction } = require('./db');
const { newToken, nowLocal, today, addMonths } = require('./util');

class UserError extends Error {}

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

function membershipStatus(db, userId) {
  const row = db.prepare(`
    SELECT m.*, p.name AS plan_name FROM memberships m
    LEFT JOIN membership_plans p ON p.id = m.plan_id
    WHERE m.user_id = ? ORDER BY m.end_date DESC LIMIT 1
  `).get(userId);
  if (!row) return { active: false, current: null };
  return { active: row.end_date >= today(), current: row };
}

function grantMembership(db, { userId, planId, paymentId }) {
  const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ?').get(planId);
  if (!plan) throw new UserError('Membership plan not found.');
  const { active, current } = membershipStatus(db, userId);
  // Renewals extend from the current expiry so members never lose paid time.
  const startDate = active ? nextDay(current.end_date) : today();
  const endDate = addMonths(startDate, plan.duration_months);
  db.prepare(`INSERT INTO memberships (user_id, plan_id, payment_id, start_date, end_date)
              VALUES (?, ?, ?, ?, ?)`).run(userId, planId, paymentId ?? null, startDate, endDate);
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

function reservedSeats(db, eventId, excludeRsvpId = 0) {
  return db.prepare(`SELECT COALESCE(SUM(party_size), 0) AS n FROM rsvps
                     WHERE event_id = ? AND status != 'cancelled' AND id != ?`)
    .get(eventId, excludeRsvpId).n;
}

function eventStats(db, eventId) {
  return db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'confirmed') AS confirmed_parties,
      COALESCE(SUM(party_size) FILTER (WHERE status = 'confirmed'), 0) AS confirmed_people,
      COUNT(*) FILTER (WHERE status = 'pending_payment') AS pending_parties,
      COALESCE(SUM(party_size) FILTER (WHERE status = 'pending_payment'), 0) AS pending_people,
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

function householdSize(db, userId) {
  return 1 + db.prepare('SELECT COUNT(*) AS n FROM household_members WHERE user_id = ?').get(userId).n;
}

// A member can bring themselves plus the family members listed on their profile,
// never more than the event's own per-RSVP limit.
function maxPartySize(db, event, userId) {
  return Math.min(event.max_party_size, householdSize(db, userId));
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

function amountDue(db, rsvp, event) {
  return Math.max(0, event.fee_cents * rsvp.party_size - paidForRsvp(db, rsvp.id));
}

function rsvpWindowOpen(event) {
  const now = nowLocal();
  if (event.status !== 'published') return false;
  if (event.starts_at <= now) return false;
  if (event.rsvp_deadline && event.rsvp_deadline < now) return false;
  return true;
}

/**
 * Creates or updates a member's RSVP. Returns { rsvp, amountDue }.
 * Free events (or fully paid RSVPs) are confirmed immediately; otherwise the RSVP
 * waits in pending_payment until the balance is paid.
 */
function upsertRsvp(db, { eventId, userId, partySize }) {
  return transaction(db, () => {
    const event = getEvent(db, eventId);
    if (!event) throw new UserError('Event not found.');
    if (!rsvpWindowOpen(event)) throw new UserError('RSVPs are closed for this event.');
    if (event.members_only && !membershipStatus(db, userId).active) {
      throw new UserError('This event is for members with an active membership.');
    }
    const maxParty = maxPartySize(db, event, userId);
    if (!Number.isInteger(partySize) || partySize < 1 || partySize > maxParty) {
      throw new UserError(maxParty === 1
        ? 'You can register 1 person. Add your family members to your profile to bring them.'
        : `Number of people must be between 1 and ${maxParty} (you plus the family members on your profile).`);
    }

    const existing = db.prepare('SELECT * FROM rsvps WHERE event_id = ? AND user_id = ?')
      .get(eventId, userId);
    if (existing?.checked_in_at) throw new UserError('You have already checked in to this event.');

    if (event.capacity) {
      const taken = reservedSeats(db, eventId, existing?.id ?? 0);
      if (taken + partySize > event.capacity) {
        const left = Math.max(0, event.capacity - taken);
        throw new UserError(`Sorry, only ${left} spot${left === 1 ? '' : 's'} left for this event.`);
      }
    }

    let rsvpId;
    let qrReplaced = false;
    if (existing) {
      if (existing.status !== 'cancelled' && existing.party_size === partySize) {
        return { rsvp: existing, amountDue: amountDue(db, existing, event), qrReplaced };
      }
      // Any change in guest count (or re-opening a cancelled RSVP) issues a new QR code,
      // so a ticket showing the old number of people can never be scanned.
      replaceQrToken(db, existing, existing.status === 'cancelled' ? 'rsvp reopened' : `guests changed ${existing.party_size} → ${partySize}`);
      qrReplaced = existing.status !== 'cancelled';
      db.prepare(`UPDATE rsvps SET party_size = ?, status = 'pending_payment', updated_at = datetime('now')
                  WHERE id = ?`).run(partySize, existing.id);
      rsvpId = existing.id;
    } else {
      rsvpId = Number(db.prepare(`INSERT INTO rsvps (event_id, user_id, party_size, status, qr_token)
                                  VALUES (?, ?, ?, 'pending_payment', ?)`)
        .run(eventId, userId, partySize, newToken()).lastInsertRowid);
    }
    // Any checkout started for the old party size is now stale.
    db.prepare(`UPDATE payments SET status = 'cancelled' WHERE kind = 'event'
                AND reference_id = ? AND status = 'pending'`).run(rsvpId);

    const rsvp = db.prepare('SELECT * FROM rsvps WHERE id = ?').get(rsvpId);
    const due = amountDue(db, rsvp, event);
    if (due === 0) {
      db.prepare(`UPDATE rsvps SET status = 'confirmed' WHERE id = ?`).run(rsvpId);
      rsvp.status = 'confirmed';
    }
    return { rsvp, amountDue: due, qrReplaced };
  });
}

function cancelRsvp(db, { eventId, userId }) {
  const rsvp = db.prepare('SELECT * FROM rsvps WHERE event_id = ? AND user_id = ?').get(eventId, userId);
  if (!rsvp || rsvp.status === 'cancelled') throw new UserError('You do not have an RSVP for this event.');
  if (rsvp.checked_in_at) throw new UserError('This RSVP has already been checked in.');
  db.prepare(`UPDATE rsvps SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`).run(rsvp.id);
  db.prepare(`UPDATE payments SET status = 'cancelled' WHERE kind = 'event'
              AND reference_id = ? AND status = 'pending'`).run(rsvp.id);
  return { paidCents: paidForRsvp(db, rsvp.id) };
}

function confirmRsvpIfPaid(db, rsvpId) {
  const rsvp = db.prepare('SELECT * FROM rsvps WHERE id = ?').get(rsvpId);
  if (!rsvp || rsvp.status !== 'pending_payment') return;
  const event = getEvent(db, rsvp.event_id);
  if (amountDue(db, rsvp, event) === 0) {
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
  if (!Number.isInteger(guests) || guests < 1 || guests > rsvp.party_size) {
    throw new UserError(`Guests arriving must be between 1 and ${rsvp.party_size}.`);
  }
  const result = db.prepare(`
    UPDATE rsvps SET checked_in_at = datetime('now'), checked_in_by = ?, checked_in_count = ?
    WHERE qr_token = ? AND status = 'confirmed' AND checked_in_at IS NULL
  `).run(adminId, guests, String(token));
  if (result.changes === 0) throw new UserError('This QR code has already been used.');
  return findRsvpByToken(db, token);
}

// ---------- Payments ----------

function createPayment(db, { userId, kind, referenceId, description, amountCents }) {
  const id = db.prepare(`INSERT INTO payments (user_id, kind, reference_id, description, amount_cents)
                         VALUES (?, ?, ?, ?, ?)`)
    .run(userId, kind, referenceId ?? null, description, amountCents).lastInsertRowid;
  return db.prepare('SELECT * FROM payments WHERE id = ?').get(id);
}

function createEventPayment(db, { rsvpId, userId }) {
  const rsvp = db.prepare('SELECT * FROM rsvps WHERE id = ? AND user_id = ?').get(rsvpId, userId);
  if (!rsvp || rsvp.status !== 'pending_payment') throw new UserError('Nothing to pay for this RSVP.');
  const event = getEvent(db, rsvp.event_id);
  const due = amountDue(db, rsvp, event);
  if (due === 0) throw new UserError('Nothing to pay for this RSVP.');
  db.prepare(`UPDATE payments SET status = 'cancelled' WHERE kind = 'event'
              AND reference_id = ? AND status = 'pending'`).run(rsvp.id);
  return createPayment(db, {
    userId, kind: 'event', referenceId: rsvp.id, amountCents: due,
    description: `${event.title} — ${rsvp.party_size} ${rsvp.party_size === 1 ? 'person' : 'people'}`,
  });
}

function createMembershipPayment(db, { planId, userId }) {
  const plan = db.prepare('SELECT * FROM membership_plans WHERE id = ? AND active = 1').get(planId);
  if (!plan) throw new UserError('Please choose a membership plan.');
  if (plan.amount_cents === 0) {
    grantMembership(db, { userId, planId });
    return null;
  }
  return createPayment(db, {
    userId, kind: 'membership', referenceId: plan.id, amountCents: plan.amount_cents,
    description: `Membership — ${plan.name}`,
  });
}

/**
 * Marks a payment as paid and applies its effect (membership granted / RSVP confirmed).
 * Idempotent: Stripe may deliver both a redirect and a webhook for the same payment.
 * A 'cancelled' payment is still honoured if money actually arrived for it.
 */
function markPaymentPaid(db, paymentId, { method, providerRef = null, recordedBy = null }) {
  return transaction(db, () => {
    const result = db.prepare(`
      UPDATE payments SET status = 'paid', method = ?, provider_ref = COALESCE(?, provider_ref),
             recorded_by = ?, paid_at = datetime('now')
      WHERE id = ? AND status != 'paid'
    `).run(method, providerRef, recordedBy, paymentId);
    if (result.changes === 0) return false;
    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (payment.kind === 'membership') {
      grantMembership(db, { userId: payment.user_id, planId: payment.reference_id, paymentId });
    } else if (payment.kind === 'event') {
      confirmRsvpIfPaid(db, payment.reference_id);
    }
    return true;
  });
}

module.exports = {
  UserError, PROFILE_FIELDS, updateProfile, cleanProfile, membershipStatus, grantMembership,
  getEvent, eventStats, eventRevenue, amountDue, paidForRsvp, rsvpWindowOpen, reservedSeats,
  householdSize, maxPartySize, upsertRsvp, cancelRsvp, findRsvpByToken, findRetiredToken, checkIn,
  createPayment, createEventPayment, createMembershipPayment, markPaymentPaid,
};
