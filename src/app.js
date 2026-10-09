const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');

const { openDb } = require('./db');
const { SqliteStore } = require('./session-store');
const { createGateway } = require('./gateway');
const { loadUser, doorModeOnly, csrf, flash } = require('./middleware');
const { UserError } = require('./services');
const { seedDemo, isEmpty, DEMO_ACCOUNTS, DEMO_PASSWORD } = require('./demo');
const util = require('./util');
const { getContent } = require('./site');
const { imageUpload } = require('./uploads');
const { i18nMiddleware, prefsRoute } = require('./i18n');

function createApp(config) {
  const db = openDb(config.databaseFile);
  const gateway = createGateway(config, {
    // Remember each Stripe checkout page so a newer dues checkout can close older ones.
    onSession: (paymentId, sessionId) => db.prepare(`UPDATE payments SET provider_ref = ? WHERE id = ? AND status = 'pending'`)
      .run(sessionId, paymentId),
  });
  if (config.demoMode && isEmpty(db)) seedDemo(db, { photosDir: config.photosDir });
  ensureAdmin(db, config);
  // Once: the old typed-in website sponsor list becomes sponsor contacts (Admin → Contacts → Sponsors & vendors).
  require('./contacts').importWebsiteSponsors(db);

  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1);
  app.locals.db = db;
  // Set by a demo reset: display choices remembered by a browser before then are forgotten (see i18n.js).
  app.locals.prefsEpoch = db.prepare(`SELECT value FROM pages WHERE key = 'prefs_epoch'`).get()?.value || null;
  app.locals.config = config;
  app.locals.usStates = require('./usStates').US_STATES;
  app.locals.gateway = gateway;
  app.locals.imageUpload = imageUpload(config);
  Object.assign(app.locals, {
    orgName: config.orgName,
    paymentMode: gateway.mode,
    demoMode: config.demoMode,
    demoAccounts: config.demoMode ? DEMO_ACCOUNTS : [],
    demoPassword: DEMO_PASSWORD,
    ...require('./menus'),
    money: (cents) => util.formatMoney(cents, config.currency),
    monthName: util.monthName,
    fmtDate: util.formatDateTime,
    asset: assetUrl(path.join(__dirname, '..', 'public')),
  });

  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'same-origin',
      // No embedding in other sites, no plugins, no <base> tricks. (Scripts and styles aren't
      // restricted here: the pages use small inline scripts, and checkout redirects to Stripe.)
      'Content-Security-Policy': "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
      // Only this site may use the camera (door check-in); no microphone, location or payment APIs.
      'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
    });
    // Browsers must always use HTTPS for this site once they've seen it (production only).
    if (config.isProduction) res.set('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'public'), {
    maxAge: '1h',
    // The service worker must always be re-checked so app updates reach installed phones.
    setHeaders: (res, file) => { if (file.endsWith('sw.js')) res.set('Cache-Control', 'no-cache'); },
  }));
  app.use('/uploads', express.static(config.uploadsDir, { maxAge: '7d', dotfiles: 'deny' }));

  // Stripe webhooks need the raw body and must skip CSRF/session handling.
  app.use('/pay/webhook', require('./routes/webhook'));

  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(session({
    store: new SqliteStore(db),
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    // Keep members signed in while they keep using the app (30 days from their last visit).
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      // 'auto' = Secure cookie whenever the request came over HTTPS (behind Render's proxy too).
      secure: config.isProduction ? 'auto' : false,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }));
  app.use((req, res, next) => {
    res.locals.path = req.path;
    res.locals.url = req.originalUrl;
    res.locals.user = null;
    res.locals.doorMode = false;
    res.locals.adminMode = false;
    res.locals.org = getContent(db, 'org');
    next();
  });
  app.use(flash);
  app.use(loadUser(db));
  app.use(doorModeOnly);
  app.use(i18nMiddleware);
  app.use(csrf);
  app.get('/prefs', prefsRoute(db));

  app.use(require('./routes/auth'));
  app.use(require('./routes/public'));
  app.use(require('./routes/member'));
  app.use(require('./routes/donations').router);
  app.use('/pay', require('./routes/pay'));
  app.use(require('./routes/photos'));
  app.use('/admin/checkin', require('./routes/checkin'));
  app.use('/admin', require('./routes/reports'));
  app.use('/admin', require('./routes/site-admin'));
  app.use('/admin', require('./routes/admin'));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof UserError || err.name === 'MulterError') {
      if (err.name === 'MulterError') {
        req.flash('error', err.code === 'LIMIT_FILE_SIZE' ? 'That file is too large (5 MB maximum).' : 'That file could not be uploaded.');
      } else {
        req.flash('error', err.template ?? err.message, err.vars);
      }
      return res.redirect(safeBack(req));
    }
    console.error(err);
    res.status(500).render('error', { title: 'Something went wrong', message: 'Please try again in a moment.' });
  });

  return app;
}

// Stylesheet and script addresses carry a fingerprint of the file (/styles.css?v=1a2b3c4d), so after an update
// phones fetch the new file straight away instead of using a copy their browser saved earlier.
function assetUrl(publicDir) {
  const versions = new Map();
  return (file) => {
    if (!versions.has(file)) {
      let v = '';
      try { v = crypto.createHash('sha1').update(fs.readFileSync(path.join(publicDir, file))).digest('hex').slice(0, 10); } catch { /* missing file: plain URL */ }
      versions.set(file, v);
    }
    return versions.get(file) ? `${file}?v=${versions.get(file)}` : file;
  };
}

// Redirect target for "go back to the form" that can never leave this site.
function safeBack(req) {
  try {
    const ref = new URL(req.get('Referer') || '', `${req.protocol}://${req.get('host')}`);
    if (ref.host === req.get('host')) return ref.pathname + ref.search;
  } catch { /* fall through */ }
  return '/';
}

function ensureAdmin(db, config) {
  if (!config.adminEmail || !config.adminPassword) return;
  const existing = db.prepare('SELECT id, role FROM users WHERE email = ?').get(config.adminEmail);
  if (existing) {
    if (existing.role !== 'admin') db.prepare(`UPDATE users SET role = 'admin' WHERE id = ?`).run(existing.id);
    return;
  }
  db.prepare(`INSERT INTO users (email, password_hash, role, first_name, last_name)
              VALUES (?, ?, 'admin', 'Admin', 'User')`)
    .run(config.adminEmail, bcrypt.hashSync(config.adminPassword, 10));
}

module.exports = { createApp };
