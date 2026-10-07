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

function formatDateTime(value) {
  if (!value) return '';
  // SQLite's datetime('now') timestamps ("YYYY-MM-DD HH:MM:SS") are UTC.
  const isSqliteUtc = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
  const d = new Date(value.length === 10 ? `${value}T00:00` : isSqliteUtc ? `${value.replace(' ', 'T')}Z` : value);
  if (Number.isNaN(d.getTime())) return value;
  const opts = value.length === 10
    ? { dateStyle: 'medium' }
    : { dateStyle: 'medium', timeStyle: 'short' };
  return new Intl.DateTimeFormat('en-US', opts).format(d);
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
  formatMoney, parseMoney, parseIntInRange, newToken, nowLocal, today, addMonths,
  formatDateTime, toCsv,
};
