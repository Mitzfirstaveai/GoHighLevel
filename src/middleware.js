const crypto = require('node:crypto');

function loadUser(db) {
  return (req, res, next) => {
    req.user = req.session.userId
      ? db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)
      : null;
    if (req.session.userId && !req.user) delete req.session.userId;
    res.locals.user = req.user;
    // Door mode: a volunteer who signed in at the committee & volunteer sign-in.
    if (req.session.doorMode && (!req.user || req.user.role === 'admin' || !req.user.checkin_access)) delete req.session.doorMode;
    res.locals.doorMode = Boolean(req.session.doorMode);
    next();
  };
}

function requireAuth(req, res, next) {
  if (req.user) return next();
  req.session.returnTo = req.originalUrl;
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  if (!req.user) return requireAuth(req, res, next);
  if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'Not allowed', message: 'Only administrators can view this page.' });
  next();
}

// Admins can always check people in. Door volunteers can once they have signed in at the
// committee & volunteer sign-in (door mode); in their member app they're ordinary members.
function canCheckIn(user, session) {
  return Boolean(user && (user.role === 'admin' || (user.checkin_access && session?.doorMode)));
}

function requireCheckin(req, res, next) {
  if (!req.user) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/admin/login');
  }
  if (canCheckIn(req.user, req.session)) return next();
  if (req.user.checkin_access) {
    req.session.returnTo = req.originalUrl;
    return res.redirect('/admin/login');
  }
  res.status(403).render('error', { title: 'Not allowed', message: 'Only committee members and door volunteers can check people in.' });
}

// In door mode the device only shows check-in, so a phone handed around at the door never
// opens the volunteer's own member pages.
const DOOR_PATHS = ['/admin/checkin', '/logout', '/prefs', '/admin/login'];
function doorModeOnly(req, res, next) {
  if (!req.session.doorMode || DOOR_PATHS.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
  res.redirect('/admin/checkin');
}

function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url');
  res.locals.csrf = req.session.csrf;
  if (req.method !== 'POST') return next();
  // Photo/spreadsheet upload forms are multipart, which is parsed later by the route,
  // so those forms carry the token in their action URL instead.
  const sent = String(req.body?._csrf || req.query?._csrf || '');
  const ok = sent.length === req.session.csrf.length
    && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.session.csrf));
  if (!ok) return res.status(403).render('error', { title: 'Session expired', message: 'Your form expired. Please go back, refresh the page and try again.' });
  next();
}

// Flash messages survive redirects and are only cleared once a page actually renders them.
// They're stored as English text (+ placeholder values) and translated when shown.
function flash(req, res, next) {
  req.flash = (type, message, vars) => {
    req.session.flash = [...(req.session.flash || []), { type, message, vars }];
  };
  res.locals.flash = [];
  const render = res.render.bind(res);
  res.render = (view, locals, cb) => {
    const t = res.locals.t || ((m) => m);
    res.locals.flash = [...(req.session.flash || []), ...res.locals.flash]
      .map((f) => ({ type: f.type, message: t(f.message, f.vars) }));
    delete req.session.flash;
    return render(view, locals, cb);
  };
  next();
}

module.exports = { loadUser, requireAuth, requireAdmin, requireCheckin, canCheckIn, doorModeOnly, csrf, flash };
