const crypto = require('node:crypto');

function loadUser(db) {
  return (req, res, next) => {
    req.user = req.session.userId
      ? db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId)
      : null;
    if (req.session.userId && !req.user) delete req.session.userId;
    res.locals.user = req.user;
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
function flash(req, res, next) {
  req.flash = (type, message) => {
    req.session.flash = [...(req.session.flash || []), { type, message }];
  };
  res.locals.flash = [];
  const render = res.render.bind(res);
  res.render = (view, locals, cb) => {
    res.locals.flash = [...(req.session.flash || []), ...res.locals.flash];
    delete req.session.flash;
    return render(view, locals, cb);
  };
  next();
}

module.exports = { loadUser, requireAuth, requireAdmin, csrf, flash };
