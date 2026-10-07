// Pages anyone can see, signed in or not.
const express = require('express');
const QRCode = require('qrcode');
const { getContent } = require('../site');
const { planCoverageParts } = require('../services');
const { nowLocal } = require('../util');

const router = express.Router();

// QR code on the website that opens the GSA app section on a phone (made once per site address).
const appQrCache = new Map();
async function appQr(baseUrl) {
  if (!appQrCache.has(baseUrl)) {
    appQrCache.set(baseUrl, await QRCode.toString(`${baseUrl}/#app`, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
  }
  return appQrCache.get(baseUrl);
}

// The public website. Signed-in members go straight to their app.
router.get('/', async (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/dashboard');
  const { db, config } = req.app.locals;
  // Live from the app: the next few events and the current membership levels.
  const upcoming = db.prepare(`SELECT * FROM events WHERE status = 'published' AND starts_at >= ?
                               ORDER BY starts_at LIMIT 3`).all(nowLocal());
  const plans = db.prepare('SELECT * FROM membership_plans WHERE active = 1 ORDER BY sort_order, amount_cents').all()
    .map((plan) => ({ ...plan, coverageParts: planCoverageParts(plan) }));
  res.render('home', {
    title: 'Welcome',
    site: true,
    upcoming,
    plans,
    about: getContent(db, req.lang === 'gu' ? 'about_gu' : 'about'),
    sponsors: getContent(db, 'sponsors'),
    appQr: await appQr(config.baseUrl),
  });
});

router.get('/about', (req, res) => res.render('public/about', {
  title: 'About Us', about: getContent(req.app.locals.db, req.lang === 'gu' ? 'about_gu' : 'about'),
}));
router.get('/committee', (req, res) => res.render('public/committee', { title: 'Committee Members', committee: getContent(req.app.locals.db, 'committee') }));
router.get('/sponsors', (req, res) => res.render('public/sponsors', { title: 'Sponsors', sponsors: getContent(req.app.locals.db, 'sponsors') }));
router.get('/contact', (req, res) => res.render('public/contact', { title: 'Contact Us' }));

module.exports = router;
