const express = require('express');
const bcrypt = require('bcryptjs');
const { cleanProfile, UserError } = require('../services');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/', (req, res) => {
  if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/dashboard');
  res.render('home', { title: 'Welcome' });
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/login', { title: 'Sign in', email: '' });
});

// Slows down password guessing: after 8 wrong passwords for an email (or 30 from one address)
// within 15 minutes, sign-in is paused for that email/address until the window passes.
const FAILED_LIMIT = { perEmail: 8, perIp: 30, windowMs: 15 * 60 * 1000 };
const failures = new Map();

function tooManyFailures(keys) {
  const now = Date.now();
  return keys.some(([key, limit]) => {
    const hits = (failures.get(key) || []).filter((t) => now - t < FAILED_LIMIT.windowMs);
    failures.set(key, hits);
    return hits.length >= limit;
  });
}

function recordFailure(keys) {
  for (const [key] of keys) failures.set(key, [...(failures.get(key) || []), Date.now()]);
  if (failures.size > 10000) failures.clear(); // keep memory bounded
}

// Checks the email and password; renders the sign-in page again (with the error) on failure.
function authenticate(req, res, view) {
  const { db } = req.app.locals;
  const email = String(req.body.email || '').trim();
  const keys = [[`email:${email.toLowerCase()}`, FAILED_LIMIT.perEmail], [`ip:${req.ip}`, FAILED_LIMIT.perIp]];
  if (tooManyFailures(keys)) {
    res.locals.flash = [{ type: 'error', message: 'Too many attempts. Please wait 15 minutes and try again, or ask a committee member to reset your password.' }];
    res.status(429).render(view, { title: 'Sign in', email });
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  // Contacts added by an admin or imported have no password until they're given a login.
  if (!user?.password_hash || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    recordFailure(keys);
    res.locals.flash = [{ type: 'error', message: 'Incorrect email or password.' }];
    res.status(401).render(view, { title: 'Sign in', email });
    return null;
  }
  failures.delete(keys[0][0]);
  return user;
}

function signIn(req, res, next, user, { doorMode = false, fallback = '/' } = {}) {
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    if (doorMode) req.session.doorMode = true;
    const safe = returnTo?.startsWith('/') && !returnTo.startsWith('//') ? returnTo : null;
    res.redirect(safe && (!doorMode || safe.startsWith('/admin/checkin')) ? safe : fallback);
  });
}

router.post('/login', (req, res, next) => {
  const user = authenticate(req, res, 'auth/login');
  if (user) signIn(req, res, next, user);
});

// Committee & door volunteer sign-in. Volunteers land in door check-in mode: a check-in-only
// screen, kept separate from their member app. Ordinary members are turned away here.
router.get('/admin/login', (req, res) => {
  if (req.user?.role === 'admin') return res.redirect('/admin');
  if (req.session.doorMode) return res.redirect('/admin/checkin');
  res.render('auth/staff_login', { title: 'Committee & volunteer sign-in', email: '' });
});

router.post('/admin/login', (req, res, next) => {
  const user = authenticate(req, res, 'auth/staff_login');
  if (!user) return;
  if (user.role === 'admin') return signIn(req, res, next, user, { fallback: '/admin' });
  if (user.checkin_access) return signIn(req, res, next, user, { doorMode: true, fallback: '/admin/checkin' });
  res.locals.flash = [{ type: 'error', message: 'This sign-in is only for the committee and door volunteers. Please use the member sign-in.' }];
  res.status(403).render('auth/staff_login', { title: 'Committee & volunteer sign-in', email: user.email });
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/register', { title: 'Join', form: {} });
});

router.post('/register', (req, res, next) => {
  const { db } = req.app.locals;
  const form = req.body;
  try {
    const email = String(form.email || '').trim().toLowerCase();
    const password = String(form.password || '');
    if (!EMAIL_RE.test(email)) throw new UserError('Please enter a valid email address.');
    if (password.length < 8) throw new UserError('Password must be at least 8 characters.');
    if (password !== form.password_confirm) throw new UserError('Passwords do not match.');
    const existing = db.prepare('SELECT password_hash FROM users WHERE email = ?').get(email);
    if (existing && !existing.password_hash) {
      // Imported from WildApricot or added by the committee: an admin issues the first login.
      throw new UserError('You are already in our member records. Please ask a committee member to set up your login.');
    }
    if (existing) throw new UserError('An account with that email already exists. Try signing in.');
    const profile = cleanProfile(form);
    // With no ADMIN_EMAIL configured, the very first account becomes the administrator.
    const noAdmin = !req.app.locals.config.adminEmail
      && !db.prepare(`SELECT 1 FROM users WHERE role = 'admin'`).get();
    const id = db.prepare(`INSERT INTO users (email, password_hash, role, first_name, last_name, phone, city, native_place)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(email, bcrypt.hashSync(password, 10), noAdmin ? 'admin' : 'member', profile.first_name,
        profile.last_name, profile.phone, profile.city, profile.native_place).lastInsertRowid;
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.userId = Number(id);
      req.session.flash = [{ type: 'success', message: 'Welcome! Please complete your profile.' }];
      res.redirect('/profile');
    });
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    res.locals.flash = [{ type: 'error', message: err.message }];
    res.status(400).render('auth/register', { title: 'Join', form });
  }
});

router.post('/logout', (req, res) => {
  // A door volunteer signing out leaves the sign-in screen ready for the next volunteer.
  const next = req.session.doorMode ? '/admin/login' : '/';
  req.session.destroy(() => res.redirect(next));
});

module.exports = router;
