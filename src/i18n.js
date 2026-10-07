// Language (English / Gujarati) and text-size preferences, plus the t() translation helper.
// English text is the key; src/locales/gu.js maps it to Gujarati. Anything without a
// translation falls back to English, and is recorded in `missing` so tests can catch gaps.
const gu = require('./locales/gu');
const { formatDateTime } = require('./util');

const LANGS = ['en', 'gu'];
const SIZES = ['normal', 'large', 'xlarge'];
const missing = new Set();

// "a, b and c" — list values are passed as { list: [...] } so each part can be translated.
function formatList(parts, and = 'and') {
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} ${and} ${parts.at(-1)}`;
}

function interpolate(text, vars, mapValue = (v) => (v?.list ? formatList(v.list) : v)) {
  return vars ? String(text).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? mapValue(vars[k]) : m)) : String(text);
}

function translator(lang) {
  // Interface text: must be in the dictionary.
  // Data from the database (level names, roles…): translate if we know it, otherwise leave as is.
  const data = (text) => (lang === 'gu' && typeof text === 'string' && gu[text]) || text;
  // Placeholder values are data too (a level name, a relationship…); lists are translated part by part.
  const mapValue = (v) => (v?.list ? formatList(v.list.map((p) => t(p)), lang === 'gu' ? 'અને' : 'and') : data(v));
  const t = (text, vars) => {
    if (lang !== 'gu') return interpolate(text, vars);
    if (gu[text] === undefined) missing.add(text);
    return interpolate(gu[text] ?? text, vars, mapValue);
  };
  t.data = data;
  t.list = (parts) => mapValue({ list: parts });
  return t;
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter(([k]) => k)
    .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

const COOKIE = { maxAge: 365 * 24 * 60 * 60 * 1000, sameSite: 'lax', httpOnly: false };

// Must run after the user is loaded: a signed-in member's saved choice wins, then the cookie.
function i18nMiddleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const pick = (saved, cookie, allowed) => (allowed.includes(saved) ? saved : allowed.includes(cookie) ? cookie : allowed[0]);
  const lang = pick(req.user?.language, cookies.lang, LANGS);
  const size = pick(req.user?.text_size, cookies.size, SIZES);
  // Keep the cookie in step with the profile, so the choice survives signing out on this phone.
  if (cookies.lang !== lang) res.cookie('lang', lang, COOKIE);
  if (cookies.size !== size) res.cookie('size', size, COOKIE);
  const t = translator(lang);
  req.t = t;
  req.lang = lang;
  Object.assign(res.locals, {
    t, lang, textSize: size,
    fmtDate: (value) => formatDateTime(value, lang === 'gu' ? 'gu-IN' : 'en-US'),
    // Pick the Gujarati version of a field (title_gu, …) when reading in Gujarati and it exists.
    loc: (obj, field) => (lang === 'gu' && obj?.[`${field}_gu`]) || obj?.[field] || '',
    plural: (n, one, many) => t(n === 1 ? one : many, { n }),
  });
  next();
}

// GET /prefs?lang=gu or ?size=large (or size=next to cycle), then back to the page.
function prefsRoute(db) {
  return (req, res) => {
    const updates = {};
    if (LANGS.includes(req.query.lang)) updates.language = req.query.lang;
    if (req.query.size === 'next') updates.text_size = SIZES[(SIZES.indexOf(res.locals.textSize) + 1) % SIZES.length];
    else if (SIZES.includes(req.query.size)) updates.text_size = req.query.size;
    if (updates.language) res.cookie('lang', updates.language, COOKIE);
    if (updates.text_size) res.cookie('size', updates.text_size, COOKIE);
    if (req.user && Object.keys(updates).length) {
      db.prepare(`UPDATE users SET ${Object.keys(updates).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
        .run(...Object.values(updates), req.user.id);
    }
    const back = String(req.query.back || '/');
    res.redirect(back.startsWith('/') && !back.startsWith('//') ? back : '/');
  };
}

module.exports = { LANGS, SIZES, translator, i18nMiddleware, prefsRoute, missing, interpolate, formatList };
