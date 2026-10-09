// Event reminders: notifications on members' phones and computers, even when the app is closed (web push,
// through the service worker). Members turn them on per device. Each event sets its own schedule for ticket
// holders — the morning of, the day before and/or a week before, each at a chosen time — and can invite
// members without a ticket to RSVP at a chosen moment. Each reminder goes to each person once.
const webpush = require('web-push');
const svc = require('./services');
const { translator } = require('./i18n');
const { nowLocal, formatTime, formatMoney, formatDateTime } = require('./util');

const REMIND_FROM = '09:00';
// Kinds of reminder for ticket holders: how many days before the event, and the event column with its time.
const KINDS = [['week_before', 7, 'remind_week_before'], ['day_before', 1, 'remind_day_before'], ['day_of', 0, 'remind_day_of']];

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Keys that identify this app to the browsers' push services: from the environment, or made once and kept.
function vapidKeys(db, config = {}) {
  if (config.vapidPublicKey && config.vapidPrivateKey) return { publicKey: config.vapidPublicKey, privateKey: config.vapidPrivateKey };
  const saved = db.prepare(`SELECT value FROM settings WHERE key = 'vapid'`).get();
  if (saved) return JSON.parse(saved.value);
  const keys = webpush.generateVAPIDKeys();
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('vapid', ?)`).run(JSON.stringify(keys));
  return JSON.parse(db.prepare(`SELECT value FROM settings WHERE key = 'vapid'`).get().value);
}

function setup(db, config = {}) {
  const { publicKey, privateKey } = vapidKeys(db, config);
  const subject = /^https:\/\//.test(config.baseUrl || '') ? config.baseUrl : 'mailto:reminders@example.com';
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return publicKey;
}

function saveSubscription(db, userId, { endpoint, p256dh, auth }) {
  if (!/^https:\/\/\S+$/.test(String(endpoint || '')) || !p256dh || !auth) throw new svc.UserError('Reminders could not be turned on on this device.');
  // The same device may have been used by someone else before: the latest person to turn it on gets its reminders.
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES (?, ?, ?, ?)
              ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
    .run(userId, String(endpoint), String(p256dh), String(auth));
}

function removeSubscription(db, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(String(endpoint || ''));
}

// Everyone a ticket is for who has a login: the ticket holder, and family logins named on it.
function ticketPeople(db, rsvp) {
  const ids = new Set([rsvp.user_id]);
  for (const a of db.prepare('SELECT person FROM rsvp_attendees WHERE rsvp_id = ?').all(rsvp.id)) {
    const [kind, id] = a.person.split(':');
    if (kind === 'u') ids.add(Number(id));
    if (kind === 'h') {
      const h = db.prepare('SELECT login_user_id FROM household_members WHERE id = ?').get(Number(id));
      if (h?.login_user_id) ids.add(h.login_user_id);
    }
  }
  return [...ids];
}

// When the morning-of reminder goes out: the event's chosen time (9 AM unless changed), but no later than
// two hours before it starts (an 8:30 AM puja is reminded at 6:30).
function remindAt(startsAt, time = REMIND_FROM) {
  const [h, m] = startsAt.slice(11, 16).split(':').map(Number);
  const mins = Math.max(0, h * 60 + m - 120);
  const early = `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  return time < early ? time : early;
}

// Reminders for ticket holders due as of `now` (local 'YYYY-MM-DDTHH:MM'): each kind the event switched on,
// on its own day, from its time until the event starts. Logged by the day it went out, so each goes once.
function dueReminders(db, now = nowLocal()) {
  const day = now.slice(0, 10);
  const due = [];
  for (const [kind, daysAhead, column] of KINDS) {
    const rows = db.prepare(`SELECT r.*, e.title, e.title_gu, e.starts_at, e.location, e.${column} AS remind_time FROM rsvps r JOIN events e ON e.id = r.event_id
      WHERE e.status = 'published' AND substr(e.starts_at, 1, 10) = ? AND e.starts_at > ? AND e.${column} IS NOT NULL
        AND r.status = 'confirmed' AND r.checked_in_at IS NULL`).all(addDays(day, daysAhead), now);
    for (const r of rows) {
      const at = kind === 'day_of' ? remindAt(r.starts_at, r.remind_time) : r.remind_time;
      if (now.slice(11, 16) < at) continue;
      for (const userId of ticketPeople(db, r)) {
        if (db.prepare('SELECT 1 FROM reminders_sent WHERE rsvp_id = ? AND user_id = ? AND sent_on = ?').get(r.id, userId, day)) continue;
        if (!db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ?').get(userId)) continue; // nowhere to send it yet
        due.push({ rsvp: r, userId, kind });
      }
    }
  }
  return due;
}

// Members without a ticket to invite to RSVP, as of `now`: events whose invitation time has come and which
// are still open for RSVPs. Skips families that already have a ticket, and non-members for members-only events.
function dueInvites(db, now = nowLocal()) {
  // Not more than a day late: an invitation whose time passed long ago (an older event, the server was off) is skipped.
  const yesterday = `${addDays(now.slice(0, 10), -1)}T${now.slice(11, 16)}`;
  const events = db.prepare(`SELECT * FROM events WHERE status = 'published' AND invite_at IS NOT NULL AND invite_at <= ? AND invite_at > ? AND starts_at > ?`).all(now, yesterday, now)
    .filter((e) => svc.rsvpWindowOpen(e));
  const people = db.prepare(`SELECT DISTINCT u.id FROM users u JOIN push_subscriptions s ON s.user_id = u.id WHERE u.contact_type = 'member'`).all().map((u) => u.id);
  const due = [];
  for (const e of events) {
    for (const userId of people) {
      if (db.prepare('SELECT 1 FROM invites_sent WHERE event_id = ? AND user_id = ?').get(e.id, userId)) continue;
      const family = svc.familyUserIds(db, userId);
      if (db.prepare(`SELECT 1 FROM rsvps WHERE event_id = ? AND status != 'cancelled' AND user_id IN (${family.map(() => '?').join(',')})`).get(e.id, ...family)) continue;
      if (e.members_only && !svc.membershipStatus(db, userId).active) continue;
      due.push({ event: e, userId });
    }
  }
  return due;
}

const languageOf = (db, userId) => (db.prepare('SELECT language FROM users WHERE id = ?').get(userId)?.language === 'gu' ? 'gu' : 'en');
const placeOf = (event) => String(event.location || '').split(/[|,]/)[0].trim();

// The reminder, in the person's language: "Today: Navratri Garba" / "7:30 PM · GSA Community Center. …";
// the day before and a week before name the date: "Tomorrow: …" / "Next week: …" with "Sat, Oct 17, 7:30 PM".
function message(db, rsvp, userId, kind = 'day_of') {
  const lang = languageOf(db, userId);
  const locale = lang === 'gu' ? 'gu-IN' : 'en-US';
  const t = translator(lang);
  const title = (lang === 'gu' && rsvp.title_gu) || rsvp.title;
  const due = svc.amountDue(db, rsvp);
  const when = kind === 'day_of' ? formatTime(rsvp.starts_at, locale) : formatDateTime(rsvp.starts_at, locale);
  const parts = [when, placeOf(rsvp)].filter(Boolean).join(' · ');
  const heading = { day_of: 'Today: {event}', day_before: 'Tomorrow: {event}', week_before: 'Next week: {event}' }[kind];
  return {
    title: t(heading, { event: title }),
    body: due ? `${parts}. ${t('Please pay {amount} at the door.', { amount: formatMoney(due, 'USD') })}` : `${parts}. ${t('Tap to open your QR ticket.')}`,
    url: `/tickets/${rsvp.id}`,
    tag: `event-${rsvp.event_id}`,
  };
}

// "RSVP now: Diwali Dinner" / "Sun, Nov 1, 5:00 PM · GSA Community Center. Tap to RSVP."
function inviteMessage(db, event, userId) {
  const lang = languageOf(db, userId);
  const t = translator(lang);
  const title = (lang === 'gu' && event.title_gu) || event.title;
  const parts = [formatDateTime(event.starts_at, lang === 'gu' ? 'gu-IN' : 'en-US'), placeOf(event)].filter(Boolean).join(' · ');
  return { title: t('RSVP now: {event}', { event: title }), body: `${parts}. ${t('Tap to RSVP.')}`, url: `/events/${event.id}`, tag: `invite-${event.id}` };
}

async function deliver(db, userId, payload) {
  let sent = 0;
  for (const s of db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId)) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 6 * 3600 });
      sent++;
    } catch (err) {
      // The device turned notifications off or the app was removed (404/410), or it signed up with keys this
      // server no longer has (401/403, e.g. after the database was replaced): forget it. The app signs the
      // device up again the next time it is opened.
      if ([401, 403, 404, 410].includes(err.statusCode)) removeSubscription(db, s.endpoint);
      else console.error(`Reminder not delivered (${err.statusCode || err.message})`);
    }
  }
  return sent;
}

// Sends what's due now; returns how many notifications went out.
async function sendDue(db, now = nowLocal()) {
  let sent = 0;
  // Logged as sent only once it reached a device. If none took it (a passing outage, or the device's sign-up was
  // stale), it is tried again next time, and as soon as the device signs up again.
  for (const { rsvp, userId, kind } of dueReminders(db, now)) {
    const n = await deliver(db, userId, message(db, rsvp, userId, kind));
    if (n) db.prepare('INSERT OR IGNORE INTO reminders_sent (rsvp_id, user_id, sent_on) VALUES (?, ?, ?)').run(rsvp.id, userId, now.slice(0, 10));
    sent += n;
  }
  for (const { event, userId } of dueInvites(db, now)) {
    const n = await deliver(db, userId, inviteMessage(db, event, userId));
    if (n) db.prepare('INSERT OR IGNORE INTO invites_sent (event_id, user_id) VALUES (?, ?)').run(event.id, userId);
    sent += n;
  }
  return sent;
}

// "Send a test" from the profile: proves this person's devices can show reminders.
async function sendTest(db, userId, lang) {
  const t = translator(lang === 'gu' ? 'gu' : 'en');
  return deliver(db, userId, { title: t('Event reminders are on'), body: t('Reminders for your events, and invitations to RSVP, will appear like this.'), url: '/tickets', tag: 'test' });
}

function startReminders(db, config) {
  if (!config.reminderMinutes) return null;
  setup(db, config);
  const run = () => sendDue(db).catch((err) => console.error('Reminders:', err.message));
  run();
  return setInterval(run, config.reminderMinutes * 60 * 1000);
}

module.exports = { setup, vapidKeys, saveSubscription, removeSubscription, dueReminders, dueInvites, remindAt, message, inviteMessage, sendDue, sendTest, startReminders, ticketPeople };
