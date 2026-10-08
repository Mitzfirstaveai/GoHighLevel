const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware');
const svc = require('../services');
const { parseMoney, toCsv, localDate, today } = require('../util');

const router = express.Router();
const PRESETS = [2100, 5100, 10100, 25100, 50100]; // the customary "+1" amounts

function campaignsWithProgress(db, activeOnly) {
  return db.prepare(`SELECT * FROM campaigns ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY active DESC, created_at DESC`).all()
    .map((c) => ({ ...c, progress: svc.campaignProgress(db, c.id) }));
}

// ---------- Members ----------

router.get('/donate', requireAuth, (req, res) => {
  const { db } = req.app.locals;
  // The General fund (gifts not for a particular fund) shows what it has raised this year.
  const general = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(DISTINCT user_id) AS donors FROM payments
    WHERE kind = 'donation' AND status = 'paid' AND reference_id IS NULL AND paid_at >= ?`).get(`${today().slice(0, 4)}-01-01`);
  res.render('member/donate', {
    title: 'Donate', campaigns: campaignsWithProgress(db, true), presets: PRESETS, general,
    // "Give to this fund" links (?campaign=3, or ?campaign=general) pick the fund in the form below.
    selected: req.query.campaign === 'general' ? 'general' : Number(req.query.campaign) || null,
  });
});

router.post('/donate', requireAuth, async (req, res) => {
  const { db, gateway } = req.app.locals;
  const amountCents = req.body.amount === 'other' ? parseMoney(req.body.other_amount) : Number(req.body.amount);
  const payment = svc.createDonationPayment(db, {
    userId: req.user.id, campaignId: Number(req.body.campaign_id) || null, amountCents, note: req.body.note,
  });
  const url = await gateway.startCheckout(payment, req.user);
  if (!url) throw new svc.UserError('Online giving is not available yet. Please give to a committee member.');
  res.redirect(303, url);
});

// ---------- Admin ----------

function donationFilters(query) {
  return {
    q: String(query.q || '').trim(),
    campaign: String(query.campaign || ''),
    from: /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : '',
  };
}

function searchDonations(db, f) {
  const where = [`p.kind = 'donation'`, `p.status = 'paid'`];
  const args = [];
  if (f.q) { where.push(`(u.first_name || ' ' || u.last_name LIKE ? OR u.email LIKE ?)`); args.push(`%${f.q}%`, `%${f.q}%`); }
  if (f.campaign === 'general') where.push('p.reference_id IS NULL');
  else if (f.campaign) { where.push('p.reference_id = ?'); args.push(Number(f.campaign)); }
  if (f.from) { where.push("substr(datetime(p.paid_at, 'localtime'), 1, 10) >= ?"); args.push(f.from); }
  if (f.to) { where.push("substr(datetime(p.paid_at, 'localtime'), 1, 10) <= ?"); args.push(f.to); }
  return db.prepare(`SELECT p.*, u.first_name, u.last_name, u.email, c.title AS campaign_title FROM payments p
    JOIN users u ON u.id = p.user_id LEFT JOIN campaigns c ON c.id = p.reference_id
    WHERE ${where.join(' AND ')} ORDER BY p.paid_at DESC`).all(...args);
}

router.get('/admin/donations', requireAdmin, (req, res) => {
  const { db } = req.app.locals;
  const filters = donationFilters(req.query);
  const donations = searchDonations(db, filters);
  res.render('admin/donations', {
    title: 'Donations', donations, filters, campaigns: campaignsWithProgress(db, false),
    total: donations.reduce((s, d) => s + d.amount_cents, 0),
    donorCount: new Set(donations.map((d) => d.user_id)).size,
    exportQuery: new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString(),
  });
});

router.get('/admin/donations.csv', requireAdmin, (req, res) => {
  const { db, money } = req.app.locals;
  const rows = [['Date', 'First name', 'Last name', 'Email', 'Fund', 'Amount', 'Method', 'Reference', 'Note', 'Receipt #']];
  for (const d of searchDonations(db, donationFilters(req.query))) {
    rows.push([localDate(d.paid_at), d.first_name, d.last_name, d.email, d.campaign_title || 'General fund',
      money(d.amount_cents), d.method, d.provider_ref, d.note, receiptNumber(d.id)]);
  }
  res.attachment('donations.csv').type('text/csv').send(toCsv(rows));
});

router.post('/admin/campaigns', requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 150);
  const goal = String(req.body.goal || '').trim() ? parseMoney(req.body.goal) : null;
  if (!title) throw new svc.UserError('Give the fund a name, e.g. "Facility Fund".');
  if (goal !== null && !(goal > 0)) throw new svc.UserError('The goal must be an amount like 25000.');
  req.app.locals.db.prepare('INSERT INTO campaigns (title, description, goal_cents) VALUES (?, ?, ?)')
    .run(title, String(req.body.description || '').trim().slice(0, 1000) || null, goal);
  req.flash('success', `"${title}" is now open for donations.`);
  res.redirect('/admin/donations');
});

router.post('/admin/campaigns/:id/toggle', requireAdmin, (req, res) => {
  req.app.locals.db.prepare('UPDATE campaigns SET active = 1 - active WHERE id = ?').run(req.params.id);
  res.redirect('/admin/donations');
});

function receiptNumber(paymentId) {
  return `GSA-${String(paymentId).padStart(6, '0')}`;
}

module.exports = { router, receiptNumber, campaignsWithProgress };
