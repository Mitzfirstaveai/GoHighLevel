// Admin reports: financial summary + QuickBooks export, and membership/event trends.
const express = require('express');
const { requireAdmin } = require('../middleware');
const { columnChart, barChart } = require('../charts');
const { toCsv, nowLocal, localDate } = require('../util');
const { receiptNumber } = require('./donations');

const router = express.Router();
router.use(requireAdmin);

const CATEGORIES = [
  ['membership', 'Membership dues'],
  ['event', 'Event fees'],
  ['donation', 'Donations'],
  ['other', 'Other income'],
];
const categoryOf = (kind) => (kind === 'membership_upgrade' ? 'membership' : kind);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Dollar labels for chart axes: $0 / $500 / $1.5K.
const compactMoney = (cents) => {
  const d = cents / 100;
  return d >= 1000 ? `$${(d / 1000).toFixed(d % 1000 === 0 ? 0 : 1)}K` : `$${Math.round(d)}`;
};

function paidPayments(db, year) {
  return db.prepare(`SELECT p.*, u.first_name, u.last_name FROM payments p JOIN users u ON u.id = p.user_id
                     WHERE p.status = 'paid' AND substr(datetime(p.paid_at, 'localtime'), 1, 4) = ? ORDER BY p.paid_at`).all(String(year));
}

function yearsWithData(db) {
  const years = db.prepare(`SELECT DISTINCT substr(datetime(paid_at, 'localtime'), 1, 4) AS y FROM payments WHERE status = 'paid' ORDER BY y DESC`).all().map((r) => r.y);
  const current = nowLocal().slice(0, 4);
  return years.includes(current) ? years : [current, ...years];
}

router.get('/reports', (req, res) => {
  const { db } = req.app.locals;
  const years = yearsWithData(db);
  const year = years.includes(req.query.year) ? req.query.year : years[0];
  const payments = paidPayments(db, year);
  const grid = MONTHS.map(() => Object.fromEntries(CATEGORIES.map(([k]) => [k, 0])));
  for (const p of payments) grid[Number(localDate(p.paid_at).slice(5, 7)) - 1][categoryOf(p.kind)] += p.amount_cents;
  const monthTotals = grid.map((m) => Object.values(m).reduce((a, b) => a + b, 0));
  const totals = Object.fromEntries(CATEGORIES.map(([k]) => [k, grid.reduce((s, m) => s + m[k], 0)]));
  const events = db.prepare(`SELECT e.id, e.title, e.starts_at, SUM(p.amount_cents) AS cents FROM payments p
    JOIN rsvps r ON r.id = p.reference_id JOIN events e ON e.id = r.event_id
    WHERE p.kind = 'event' AND p.status = 'paid' AND substr(datetime(p.paid_at, 'localtime'), 1, 4) = ? GROUP BY e.id ORDER BY cents DESC`).all(year);
  const funds = db.prepare(`SELECT COALESCE(c.title, 'General fund') AS title, SUM(p.amount_cents) AS cents, COUNT(DISTINCT p.user_id) AS donors
    FROM payments p LEFT JOIN campaigns c ON c.id = p.reference_id
    WHERE p.kind = 'donation' AND p.status = 'paid' AND substr(datetime(p.paid_at, 'localtime'), 1, 4) = ? GROUP BY p.reference_id ORDER BY cents DESC`).all(year);
  res.render('admin/reports', {
    title: `Financial report ${year}`, year, years, grid, monthTotals, totals, categories: CATEGORIES, months: MONTHS, events, funds,
    grandTotal: monthTotals.reduce((a, b) => a + b, 0),
    chart: columnChart({
      title: `Income by month, ${year}`, series: ['Income'], format: compactMoney,
      rows: MONTHS.map((m, i) => ({ label: m, values: [monthTotals[i]] })),
    }),
  });
});

// QuickBooks-friendly CSV (one sales receipt per payment; map "Item" to your income accounts on import).
router.get('/reports/quickbooks.csv', (req, res) => {
  const { db } = req.app.locals;
  const year = /^\d{4}$/.test(req.query.year || '') ? req.query.year : nowLocal().slice(0, 4);
  const label = Object.fromEntries(CATEGORIES);
  const methods = { stripe: 'Credit Card', demo: 'Credit Card', cash: 'Cash', check: 'Check', other: 'Other' };
  const rows = [['Date', 'Transaction Type', 'Num', 'Customer', 'Item', 'Memo', 'Payment Method', 'Ref No', 'Amount']];
  for (const p of paidPayments(db, year)) {
    const [y, m, d] = localDate(p.paid_at).split('-');
    rows.push([`${m}/${d}/${y}`, 'Sales Receipt', receiptNumber(p.id), `${p.first_name} ${p.last_name}`, label[categoryOf(p.kind)],
      p.description, methods[p.method] || 'Other', p.provider_ref || '', (p.amount_cents / 100).toFixed(2)]);
  }
  res.attachment(`gsa-quickbooks-${year}.csv`).type('text/csv').send(toCsv(rows));
});

router.get('/insights', (req, res) => {
  const { db } = req.app.locals;
  const today = nowLocal().slice(0, 10);
  const status = db.prepare(`SELECT
      COUNT(*) FILTER (WHERE m.end_date >= ?) AS active,
      COUNT(*) FILTER (WHERE m.end_date < ?) AS expired,
      COUNT(*) FILTER (WHERE m.end_date IS NULL) AS never
    FROM users u LEFT JOIN memberships m ON m.id = (SELECT id FROM memberships WHERE user_id = u.id ORDER BY end_date DESC, id DESC LIMIT 1)`)
    .get(today, today);
  // One row per member: the membership in effect today (after an upgrade, the newest one).
  const inEffect = `SELECT m.* FROM memberships m WHERE m.id = (SELECT MAX(id) FROM memberships x
    WHERE x.user_id = m.user_id AND x.start_date <= :today AND x.end_date >= :today)`;
  const families = db.prepare(`SELECT COALESCE(SUM(1 + (SELECT COUNT(*) FROM household_members h WHERE h.user_id = m.user_id)), 0) AS n
    FROM (${inEffect}) m`).get({ today }).n;

  // People who joined (first membership) in each of the last 12 months.
  const months = [];
  const d = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
  for (let i = 11; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    months.push(m.toISOString().slice(0, 7));
  }
  const firstStarts = db.prepare('SELECT MIN(start_date) AS first FROM memberships GROUP BY user_id').all();
  const joins = months.map((m) => firstStarts.filter((r) => r.first.startsWith(m)).length);

  const levels = db.prepare(`SELECT p.name, COUNT(*) AS n FROM (${inEffect}) m JOIN membership_plans p ON p.id = m.plan_id
    GROUP BY p.id ORDER BY p.sort_order, p.amount_cents`).all({ today });

  const recentEvents = db.prepare(`SELECT e.title, e.starts_at,
      COALESCE(SUM(r.party_size) FILTER (WHERE r.status = 'confirmed'), 0) AS registered,
      COALESCE(SUM(r.checked_in_count), 0) AS arrived
    FROM events e LEFT JOIN rsvps r ON r.event_id = e.id
    WHERE e.status = 'published' AND e.starts_at < ? GROUP BY e.id ORDER BY e.starts_at DESC LIMIT 6`).all(today).reverse();

  const expiringSoon = db.prepare(`SELECT COUNT(*) AS n FROM memberships m WHERE m.end_date BETWEEN ? AND date(?, '+60 days')
    AND NOT EXISTS (SELECT 1 FROM memberships later WHERE later.user_id = m.user_id AND later.end_date > m.end_date)`).get(today, today).n;

  const short = (t) => (t.length > 12 ? `${t.slice(0, 11)}…` : t);
  res.render('admin/insights', {
    title: 'Trends', status, families, expiringSoon,
    joinsChart: columnChart({
      title: 'New members per month', series: ['New members'],
      rows: months.map((m, i) => ({ label: MONTHS[Number(m.slice(5)) - 1], values: [joins[i]] })),
    }),
    levelsChart: levels.length ? barChart({ title: 'Active memberships by level', rows: levels.map((l) => ({ label: l.name, value: l.n })) }) : '',
    eventsChart: recentEvents.length ? columnChart({
      title: 'Registered vs. arrived at recent events', series: ['Registered', 'Arrived'],
      rows: recentEvents.map((e) => ({ label: short(e.title), values: [e.registered, e.arrived] })),
    }) : '',
  });
});

module.exports = router;
