// Event-day reminders: a notification on members' phones and computers on the day of an event they
// have a ticket for, even when the app is closed (web push, through the service worker). Members turn
// it on per device; each person gets one reminder per ticket, in the morning (or two hours before an
// early event, or straight away when they turn reminders on later in the day).
const webpush = require('web-push');
const svc = require('./services');
const { translator } = require('./i18n');
const { nowLocal, formatTime, formatMoney } = require('./util');

const REMIND_FROM = '09:00';

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

// When a ticket's reminder goes out: 9 AM, or two hours before an event that starts before 11 AM.
function remindAt(startsAt) {
  const start = startsAt.slice(11, 16);
  if (start >= '11:00') return REMIND_FROM;
  const [h, m] = start.split(':').map(Number);
  const mins = Math.max(0, h * 60 + m - 120);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

// Tickets for today's events that someone still needs reminding about, as of `now` (local 'YYYY-MM-DDTHH:MM').
function dueReminders(db, now = nowLocal()) {
  const day = now.slice(0, 10);
  const rows = db.prepare(`SELECT r.*, e.title, e.title_gu, e.starts_at, e.location FROM rsvps r JOIN events e ON e.id = r.event_id
    WHERE e.status = 'published' AND substr(e.starts_at, 1, 10) = ? AND e.starts_at > ?
      AND r.status = 'confirmed' AND r.checked_in_at IS NULL`).all(day, now);
  const due = [];
  for (const r of rows) {
    if (now.slice(11, 16) < remindAt(r.starts_at)) continue;
    for (const userId of ticketPeople(db, r)) {
      if (db.prepare('SELECT 1 FROM reminders_sent WHERE rsvp_id = ? AND user_id = ? AND sent_on = ?').get(r.id, userId, day)) continue;
      if (!db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ?').get(userId)) continue; // nowhere to send it yet
      due.push({ rsvp: r, userId });
    }
  }
  return due;
}

// The notification, in the person's language: "Today: Navratri Garba" / "7:30 PM · GSA Community Center".
function message(db, rsvp, userId) {
  const user = db.prepare('SELECT language FROM users WHERE id = ?').get(userId);
  const lang = user?.language === 'gu' ? 'gu' : 'en';
  const t = translator(lang);
  const title = (lang === 'gu' && rsvp.title_gu) || rsvp.title;
  const where = String(rsvp.location || '').split(/[|,]/)[0].trim();
  const due = svc.amountDue(db, rsvp);
  const parts = [formatTime(rsvp.starts_at, lang === 'gu' ? 'gu-IN' : 'en-US'), where].filter(Boolean).join(' · ');
  return {
    title: t('Today: {event}', { event: title }),
    body: due ? `${parts}. ${t('Please pay {amount} at the door.', { amount: formatMoney(due, 'USD') })}` : `${parts}. ${t('Tap to open your QR ticket.')}`,
    url: `/tickets/${rsvp.id}`,
    tag: `event-${rsvp.event_id}`,
  };
}

async function deliver(db, userId, payload) {
  let sent = 0;
  for (const s of db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId)) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 6 * 3600 });
      sent++;
    } catch (err) {
      // The device turned notifications off or the app was removed: forget it.
      if (err.statusCode === 404 || err.statusCode === 410) removeSubscription(db, s.endpoint);
      else console.error(`Reminder not delivered (${err.statusCode || err.message})`);
    }
  }
  return sent;
}

// Sends what's due now; returns how many notifications went out.
async function sendDue(db, now = nowLocal()) {
  let sent = 0;
  for (const { rsvp, userId } of dueReminders(db, now)) {
    db.prepare('INSERT OR IGNORE INTO reminders_sent (rsvp_id, user_id, sent_on) VALUES (?, ?, ?)').run(rsvp.id, userId, now.slice(0, 10));
    sent += await deliver(db, userId, message(db, rsvp, userId));
  }
  return sent;
}

// "Send a test" from the profile: proves this person's devices can show reminders.
async function sendTest(db, userId, lang) {
  const t = translator(lang === 'gu' ? 'gu' : 'en');
  return deliver(db, userId, { title: t('Event-day reminders are on'), body: t('On the day of an event you have a ticket for, a reminder like this will appear.'), url: '/tickets', tag: 'test' });
}

function startReminders(db, config) {
  if (!config.reminderMinutes) return null;
  setup(db, config);
  const run = () => sendDue(db).catch((err) => console.error('Reminders:', err.message));
  run();
  return setInterval(run, config.reminderMinutes * 60 * 1000);
}

module.exports = { setup, vapidKeys, saveSubscription, removeSubscription, dueReminders, remindAt, message, sendDue, sendTest, startReminders, ticketPeople };
