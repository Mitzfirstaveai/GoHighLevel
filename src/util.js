const crypto = require('node:crypto');

function formatMoney(cents, currency = 'usd') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() })
    .format((cents || 0) / 100);
}

// Parses a user-entered dollar amount ("25", "25.50", "$1,000") into cents.
function parseMoney(input) {
  if (input === undefined || input === null || String(input).trim() === '') return 0;
  const cleaned = String(input).replace(/[$,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return NaN;
  return Math.round(Number(cleaned) * 100);
}

function parseIntInRange(input, min, max) {
  const n = Number(input);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function newToken() {
  return crypto.randomBytes(18).toString('base64url');
}

// Local date-time string (YYYY-MM-DDTHH:MM) used for comparing with event times,
// which are stored as entered by the admin in the org's local time.
function nowLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function today() {
  return nowLocal().slice(0, 10);
}

function addMonths(isoDate, months) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + months, d));
  // Clamp overflow (e.g. Jan 31 + 1 month) to the last day of the target month.
  if (date.getUTCDate() !== d) date.setUTCDate(0);
  return date.toISOString().slice(0, 10);
}

// SQLite datetime('now') values ("YYYY-MM-DD HH:MM:SS") are UTC; this gives the local date
// (Central time on the server), so an evening payment isn't dated tomorrow.
function localDate(value) {
  if (!value) return '';
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return String(value).slice(0, 10);
  const d = new Date(`${value.replace(' ', 'T')}Z`);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Local "YYYY-MM-DD HH:MM" for a stored UTC timestamp (used in spreadsheet exports).
function localTimestamp(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return value || '';
  const d = new Date(`${value.replace(' ', 'T')}Z`);
  const pad = (n) => String(n).padStart(2, '0');
  return `${localDate(value)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDateTime(value, locale = 'en-US') {
  if (!value) return '';
  // SQLite's datetime('now') timestamps ("YYYY-MM-DD HH:MM:SS") are UTC.
  const isSqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
  const d = new Date(value.length === 10 ? `${value}T00:00` : isSqliteUtc ? `${value.replace(' ', 'T')}Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  // Gujarati: full month names and Gujarati times of day ("8 ઑક્ટોબર, 2026, સાંજે 7:30"),
  // never shortened English-style words like "ઑક્ટો" or "PM". English keeps "Oct 8, 2026, 7:30 PM".
  if (locale.startsWith('gu')) {
    const date = new Intl.DateTimeFormat(locale, { dateStyle: 'long' }).format(d);
    if (value.length === 10) return date;
    const parts = Object.fromEntries(new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', dayPeriod: 'long' })
      .formatToParts(d).map((p) => [p.type, p.value]));
    return `${date}, ${parts.dayPeriod} ${parts.hour}:${parts.minute}`;
  }
  const opts = value.length === 10
    ? { dateStyle: 'medium' }
    : { dateStyle: 'medium', timeStyle: 'short' };
  return new Intl.DateTimeFormat(locale, opts).format(d);
}

// Month and weekday names for headings and date badges: shortened in English ("Oct", "Thu"),
// always the full word in Gujarati.
function monthName(date, locale) {
  return date.toLocaleString(locale, { month: locale.startsWith('gu') ? 'long' : 'short', timeZone: 'UTC' });
}
function weekdayName(date, locale) {
  return date.toLocaleString(locale, { weekday: locale.startsWith('gu') ? 'long' : 'short', timeZone: 'UTC' });
}

function toCsv(rows) {
  const escape = (value) => {
    let s = value === null || value === undefined ? '' : String(value);
    // Prevent spreadsheet formula injection.
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((row) => row.map(escape).join(',')).join('\r\n') + '\r\n';
}

module.exports = {
  formatMoney, parseMoney, localDate, localTimestamp, parseIntInRange, newToken, nowLocal, today, addMonths,
  formatDateTime, monthName, weekdayName, toCsv,
};
