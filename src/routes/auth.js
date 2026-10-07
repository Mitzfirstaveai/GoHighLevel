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

router.post('/login', (req, res, next) => {
  const { db } = req.app.locals;
  const email = String(req.body.email || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    res.locals.flash = [{ type: 'error', message: 'Incorrect email or password.' }];
    return res.status(401).render('auth/login', { title: 'Sign in', email });
  }
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    res.redirect(returnTo?.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
  });
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
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      throw new UserError('An account with that email already exists. Try signing in.');
    }
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
  req.session.destroy(() => res.redirect('/'));
});

module.exports = router;
