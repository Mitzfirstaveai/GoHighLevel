const express = require('express');
const bcrypt = require('bcryptjs');
const {
  cleanProfile, UserError, findFamilyInvite, familyJoinProblem, acceptFamilyInvite,
} = require('../services');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/', (req, res) => {
  if (req.user) return res.redirect('/dashboard'); // admin and door modes are sent to their own pages first
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

function signIn(req, res, next, user, { doorMode = false, adminMode = false, fallback = '/' } = {}) {
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    if (doorMode) req.session.doorMode = true;
    if (adminMode) req.session.adminMode = true;
    const safe = returnTo?.startsWith('/') && !returnTo.startsWith('//') ? returnTo : null;
    // Go back where they were heading, if that page belongs to the mode they signed in to.
    const fits = !safe ? false : doorMode ? safe.startsWith('/admin/checkin') : adminMode ? safe.startsWith('/admin') : !safe.startsWith('/admin');
    res.redirect(fits ? safe : fallback);
  });
}

router.post('/login', (req, res, next) => {
  const user = authenticate(req, res, 'auth/login');
  if (user) signIn(req, res, next, user);
});

// Committee & door volunteer sign-in. Volunteers land in door check-in mode: a check-in-only
// screen, kept separate from their member app. Ordinary members are turned away here.
router.get('/admin/login', (req, res) => {
  if (req.session.adminMode) return res.redirect('/admin');
  if (req.session.doorMode) return res.redirect('/admin/checkin');
  res.render('auth/staff_login', { title: 'Committee & volunteer sign-in', email: '' });
});

router.post('/admin/login', (req, res, next) => {
  const user = authenticate(req, res, 'auth/staff_login');
  if (!user) return;
  if (user.role === 'admin') return signIn(req, res, next, user, { adminMode: true, fallback: '/admin' });
  if (user.checkin_access) return signIn(req, res, next, user, { doorMode: true, fallback: '/admin/checkin' });
  res.locals.flash = [{ type: 'error', message: 'This sign-in is only for the committee and door volunteers. Please use the member sign-in.' }];
  res.status(403).render('auth/staff_login', { title: 'Committee & volunteer sign-in', email: user.email });
});

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('auth/register', { title: 'Join', form: {} });
});

// Creates a member account from a sign-up form. Returns the new user's id.
function createAccount(req, form) {
  const { db, config } = req.app.locals;
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
  const noAdmin = !config.adminEmail && !db.prepare(`SELECT 1 FROM users WHERE role = 'admin'`).get();
  return Number(db.prepare(`INSERT INTO users (email, password_hash, role, first_name, last_name, phone, city, native_place)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(email, bcrypt.hashSync(password, 10), noAdmin ? 'admin' : 'member', profile.first_name,
      profile.last_name, profile.phone, profile.city, profile.native_place).lastInsertRowid);
}

function startSession(req, res, next, userId, flash, to) {
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = userId;
    req.session.flash = [flash];
    res.redirect(to);
  });
}

const familyWelcome = (invite) => ({
  type: 'success',
  message: "Welcome! You're part of {owner}'s family membership. You can register yourself for events and see your family's tickets.",
  vars: { owner: `${invite.owner_first} ${invite.owner_last}` },
});

router.post('/register', (req, res, next) => {
  try {
    const id = createAccount(req, req.body);
    startSession(req, res, next, id, { type: 'success', message: 'Welcome! Please complete your profile.' }, '/profile');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    res.locals.flash = [{ type: 'error', message: req.t(err.template, err.vars) }];
    res.status(400).render('auth/register', { title: 'Join', form: req.body });
  }
});

// ---------- Family invite links ----------
// A member shares a private link so someone on their family list gets their own login: either a
// new account, or (signed in) an existing account that has no membership or family of its own.

function renderInvite(req, res, invite, form = {}, status = 200) {
  const [first, ...rest] = invite.name.split(' ');
  res.status(status).render('auth/family_join', {
    title: 'Join your family', invite, token: req.params.token,
    form: { first_name: first, last_name: rest.join(' ') || invite.owner_last, ...form },
    problem: req.user ? familyJoinProblem(req.app.locals.db, req.user, invite) : null,
  });
}

function loadInvite(req, res) {
  const invite = findFamilyInvite(req.app.locals.db, req.params.token);
  if (!invite) {
    res.status(404).render('error', { title: 'Invite link not valid', message: 'This invite link is no longer valid. Please ask your family member for a new one.' });
  }
  return invite;
}

router.get('/join/family/:token', (req, res) => {
  const invite = loadInvite(req, res);
  if (!invite) return;
  if (!req.user) req.session.returnTo = req.originalUrl; // "already have a login": sign in, come back here
  renderInvite(req, res, invite);
});

router.post('/join/family/:token', (req, res, next) => {
  const invite = loadInvite(req, res);
  if (!invite) return;
  try {
    const id = createAccount(req, req.body);
    acceptFamilyInvite(req.app.locals.db, { token: req.params.token, userId: id });
    startSession(req, res, next, id, familyWelcome(invite), '/dashboard');
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    res.locals.flash = [{ type: 'error', message: req.t(err.template, err.vars) }];
    renderInvite(req, res, invite, req.body, 400);
  }
});

// Opened while signed in as someone else (often the member who made the link, testing it on
// their own phone): sign out and come back to the link to create the invited person's login.
router.post('/join/family/:token/switch', (req, res) => {
  const to = `/join/family/${encodeURIComponent(req.params.token)}`;
  req.session.destroy(() => res.redirect(to));
});

// Already has an account: join the family with it.
router.post('/join/family/:token/link', (req, res) => {
  if (!req.user) return res.redirect(`/join/family/${encodeURIComponent(req.params.token)}`);
  const invite = loadInvite(req, res);
  if (!invite) return;
  const problem = familyJoinProblem(req.app.locals.db, req.user, invite);
  if (problem) throw new UserError(problem, { name: invite.name });
  acceptFamilyInvite(req.app.locals.db, { token: req.params.token, userId: req.user.id });
  req.flash(familyWelcome(invite).type, familyWelcome(invite).message, familyWelcome(invite).vars);
  res.redirect('/dashboard');
});

router.post('/logout', (req, res) => {
  // Signing out of a staff mode leaves the committee & volunteer sign-in ready for the next person.
  const next = req.session.doorMode || req.session.adminMode ? '/admin/login' : '/';
  req.session.destroy(() => res.redirect(next));
});

module.exports = router;
