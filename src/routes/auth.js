const express = require('express');
const bcrypt = require('bcryptjs');
const { passwordProblem, hashPassword, needsRehash, minLength } = require('../passwords');
const { isDoorAccount } = require('../door-login');
const {
  cleanProfile, PROFILE_FIELDS, UserError, findFamilyInvite, familyJoinProblem, acceptFamilyInvite,
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
  // Emails are stored in lower case; the shared door login's username ("door") is looked up the same way.
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  // Contacts added by an admin or imported have no password until they're given a login.
  if (!user?.password_hash || !bcrypt.compareSync(String(req.body.password || ''), user.password_hash)) {
    recordFailure(keys);
    res.locals.flash = [{ type: 'error', message: 'Incorrect email or password.' }];
    res.status(401).render(view, { title: 'Sign in', email });
    return null;
  }
  failures.delete(keys[0][0]);
  const password = String(req.body.password);
  // A password chosen before today's rules (or for a committee or door role it's too short for), or one
  // handed out by a committee member, has to be replaced before anything else (see /password/new).
  // The demo's sample accounts keep their shared password.
  // (The shared door login's password is set by the committee and stays as it is.)
  const demoAccount = req.app.locals.config.demoMode && user.email.endsWith('@example.com');
  user.mustChangePassword = !demoAccount && !isDoorAccount(user) && Boolean(user.password_temporary || passwordProblem(password, user));
  if (!user.mustChangePassword && needsRehash(user.password_hash)) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), user.id);
  }
  return user;
}

function signIn(req, res, next, user, { doorMode = false, doorShared = false, adminMode = false, fallback = '/' } = {}) {
  const returnTo = req.session.returnTo;
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = user.id;
    if (doorMode) req.session.doorMode = true;
    if (doorShared) req.session.doorShared = true;
    if (adminMode) req.session.adminMode = true;
    if (user.mustChangePassword) {
      req.session.mustChangePassword = true;
      req.session.returnTo = returnTo;
      return res.redirect('/password/new');
    }
    const safe = returnTo?.startsWith('/') && !returnTo.startsWith('//') ? returnTo : null;
    // Go back where they were heading, if that page belongs to the mode they signed in to.
    const fits = !safe ? false : doorMode ? safe.startsWith('/admin/checkin') : adminMode ? safe.startsWith('/admin') : !safe.startsWith('/admin');
    res.redirect(fits ? safe : fallback);
  });
}

router.post('/login', (req, res, next) => {
  const user = authenticate(req, res, 'auth/login');
  if (!user) return;
  if (isDoorAccount(user)) {
    res.locals.flash = [{ type: 'error', message: 'The door login is used on the Committee & volunteer sign-in.' }];
    return res.status(403).render('auth/login', { title: 'Sign in', email: '' });
  }
  signIn(req, res, next, user);
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
  // The shared door login: door check-in only, after the volunteer types their first name.
  if (isDoorAccount(user)) {
    if (!user.checkin_access) {
      res.locals.flash = [{ type: 'error', message: 'The shared door login is turned off. Please ask a committee member.' }];
      return res.status(403).render('auth/staff_login', { title: 'Committee & volunteer sign-in', email: user.email });
    }
    return signIn(req, res, next, user, { doorMode: true, doorShared: true, fallback: '/admin/checkin/name' });
  }
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
  const existing = db.prepare('SELECT password_hash FROM users WHERE email = ?').get(email);
  if (existing && !existing.password_hash) {
    // Imported from WildApricot or added by the committee: an admin issues the first login.
    throw new UserError('You are already in our member records. Please ask a committee member to set up your login.');
  }
  if (existing) throw new UserError('An account with that email already exists. Try signing in.');
  const problem = passwordProblem(password, { email, first_name: form.first_name, last_name: form.last_name });
  if (problem) throw new UserError(problem.message, problem.vars);
  if (password !== form.password_confirm) throw new UserError('Passwords do not match.');
  // Every member gives their phone, birth month and year, native place and address when signing up.
  const profile = cleanProfile(form, { complete: true });
  // With no ADMIN_EMAIL configured, the very first account becomes the administrator.
  const noAdmin = !config.adminEmail && !db.prepare(`SELECT 1 FROM users WHERE role = 'admin'`).get();
  return Number(db.prepare(`INSERT INTO users (email, password_hash, role, ${PROFILE_FIELDS.join(', ')})
                            VALUES (?, ?, ?, ${PROFILE_FIELDS.map(() => '?').join(', ')})`)
    .run(email, hashPassword(password), noAdmin ? 'admin' : 'member', ...PROFILE_FIELDS.map((f) => profile[f])).lastInsertRowid);
}

// ---------- Choosing a new password ----------
// After signing in with a password that doesn't meet the rules, or a temporary one from a committee member,
// this is the only page until a new password is chosen (the app sends every other page here).
const afterPasswordChange = (req) => {
  const back = req.session.returnTo;
  delete req.session.returnTo;
  if (back?.startsWith('/') && !back.startsWith('//')) return back;
  return req.session.adminMode ? '/admin' : req.session.doorMode ? '/admin/checkin' : '/dashboard';
};

router.get('/password/new', (req, res) => {
  if (!req.user || !req.session.mustChangePassword) return res.redirect('/');
  res.render('auth/password_new', { title: 'Choose a new password', passwordMin: minLength(req.user) });
});

router.post('/password/new', (req, res) => {
  if (!req.user || !req.session.mustChangePassword) return res.redirect('/');
  const { password, password_confirm: confirm } = req.body;
  const problem = passwordProblem(password, req.user);
  const error = problem ? req.t(problem.message, problem.vars)
    : password !== confirm ? req.t('Passwords do not match.')
    : bcrypt.compareSync(String(password), req.user.password_hash) ? req.t('Please choose a password different from the one you signed in with.') : null;
  if (error) {
    res.locals.flash = [{ type: 'error', message: error }];
    return res.status(400).render('auth/password_new', { title: 'Choose a new password', passwordMin: minLength(req.user) });
  }
  req.app.locals.db.prepare('UPDATE users SET password_hash = ?, password_temporary = 0 WHERE id = ?').run(hashPassword(password), req.user.id);
  delete req.session.mustChangePassword;
  req.flash('success', 'Password changed.');
  res.redirect(afterPasswordChange(req));
});

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

// A family login starts with what the family already gave: the family's address and native place,
// and the birth month and year on the family list (all can be changed on the form).
function inviteDefaults(db, invite) {
  const owner = db.prepare('SELECT address_line1, address_line2, city, state, postal_code, native_place FROM users WHERE id = ?').get(invite.user_id);
  const [first, ...rest] = invite.name.split(' ');
  return { ...owner, first_name: first, last_name: rest.join(' ') || invite.owner_last, birth_month: invite.birth_month, birth_year: invite.birth_year,
    birth_day: invite.birthday ? Number(invite.birthday.slice(3)) : '' };
}

function renderInvite(req, res, invite, form = {}, status = 200) {
  res.status(status).render('auth/family_join', {
    title: 'Join your family', invite, token: req.params.token,
    form: { ...inviteDefaults(req.app.locals.db, invite), ...form },
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
    // Anything left empty is taken from what the family already gave (the form shows these filled in).
    const given = Object.fromEntries(Object.entries(req.body).filter(([, v]) => String(v ?? '').trim()));
    const id = createAccount(req, { ...inviteDefaults(req.app.locals.db, invite), ...given });
    acceptFamilyInvite(req.app.locals.db, { token: req.params.token, userId: id });
    // Their birth date now also fills in the family list, if it didn't have it yet.
    const u = req.app.locals.db.prepare('SELECT birth_year, birth_month, birthday FROM users WHERE id = ?').get(id);
    req.app.locals.db.prepare(`UPDATE household_members SET birth_year = COALESCE(birth_year, ?), birth_month = COALESCE(birth_month, ?),
      birthday = COALESCE(birthday, CASE WHEN COALESCE(birth_month, ?) = ? THEN ? END) WHERE id = ?`)
      .run(u.birth_year, u.birth_month, u.birth_month, u.birth_month, u.birthday, invite.id);
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
