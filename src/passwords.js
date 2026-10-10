// Password rules and storage. Passwords are never stored or shown: only a bcrypt hash (one-way, salted,
// deliberately slow), so nobody — committee members included — can read them back.
//
// Rules (checked whenever a password is chosen, and at sign-in for passwords chosen before the rules):
// at least 10 characters for members and 12 for committee members and door volunteers; an uppercase letter,
// a lowercase letter, a number and a symbol; not a common or easily guessed password; not the person's
// own name or email.
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');

const ROUNDS = 12; // bcrypt work factor: about a quarter of a second per check, which slows guessing
const MAX_LENGTH = 64; // bcrypt only uses the first 72 bytes
const minLength = (user) => (isStaff(user) ? 12 : 10);
const isStaff = (user) => Boolean(user && (user.role === 'admin' || user.checkin_access));

// Words people reach for first (compared with the password's letters only, so "Garba@2026" counts as "garba").
const COMMON_WORDS = new Set([
  'password', 'passwort', 'passw', 'pass', 'welcome', 'letmein', 'login', 'admin', 'administrator', 'user', 'guest', 'test',
  'changeme', 'secret', 'default', 'qwerty', 'qwertyuiop', 'asdf', 'asdfgh', 'zxcv', 'abc', 'abcd', 'abcdef', 'iloveyou',
  'love', 'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball', 'soccer', 'cricket', 'master', 'shadow',
  'superman', 'batman', 'trustno', 'hello', 'freedom', 'whatever', 'computer', 'internet', 'samsung', 'iphone', 'google',
  'india', 'bharat', 'hindustan', 'gujarat', 'gujarati', 'gujju', 'amdavad', 'ahmedabad', 'surat', 'baroda', 'vadodara',
  'rajkot', 'arkansas', 'littlerock', 'garba', 'navratri', 'diwali', 'holi', 'dandiya', 'samaj', 'gsa', 'om', 'jai',
  'jaishreekrishna', 'jayshreekrishna', 'jaishreeram', 'jaimataji', 'krishna', 'ram', 'shiva', 'ganesh', 'ganesha',
  'hanuman', 'mataji', 'amma', 'mummy', 'papa', 'family', 'member', 'temple', 'mandir',
]);
const SEQUENCES = ['0123', '1234', '2345', '3456', '4567', '5678', '6789', '9876', '8765', '7654', '6543', '5432', '4321',
  'abcd', 'bcde', 'qwer', 'wert', 'asdf', 'zxcv'];

// Why this password can't be used (an English message for UserError, with {n}), or null when it's fine.
// `user` gives the email and names it must not contain, and whether the stricter staff length applies.
function passwordProblem(password, user = {}) {
  const pw = String(password || '');
  const min = minLength(user);
  if (pw.length < min) return { message: 'Password must be at least {n} characters.', vars: { n: min } };
  if (pw.length > MAX_LENGTH) return { message: 'Password is too long (at most {n} characters).', vars: { n: MAX_LENGTH } };
  if (!/\p{Lu}/u.test(pw) || !/\p{Ll}/u.test(pw) || !/\d/.test(pw) || !/[^\p{L}\p{N}\s]/u.test(pw)) {
    return { message: 'Password must include an uppercase letter, a lowercase letter, a number and a symbol.' };
  }
  const lower = pw.toLowerCase();
  const letters = lower.replace(/[^\p{L}]/gu, '');
  if (letters.length < 4 || COMMON_WORDS.has(letters) || /(.)\1{3,}/u.test(lower) || SEQUENCES.some((s) => lower.includes(s))) {
    return { message: 'That password is too common or easy to guess. Please choose another.' };
  }
  const own = [...String(user.email || '').toLowerCase().split('@')[0].split(/[^\p{L}\p{N}]+/u), user.first_name, user.last_name]
    .map((w) => String(w || '').toLowerCase()).filter((w) => w.length >= 3);
  if (own.some((w) => lower.includes(w))) return { message: "Password can't contain your name or email." };
  return null;
}

const hashPassword = (password) => bcrypt.hashSync(String(password), ROUNDS);
// Hashes made before the work factor was raised are upgraded the next time the person signs in.
const needsRehash = (hash) => bcrypt.getRounds(hash) < ROUNDS;

// A password a committee member hands out (reset, or a new contact's first login): random and meeting every
// rule, without look-alike characters; the member must replace it at their first sign-in.
function temporaryPassword() {
  const pick = (chars) => chars[crypto.randomInt(chars.length)];
  const upper = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const groups = Array.from({ length: 3 }, () => pick(upper) + pick(lower) + pick(lower) + pick(digits));
  return `${groups.join('-')}!`; // e.g. Kmp4-Rtx7-Hbn3! (16 characters)
}

module.exports = { passwordProblem, hashPassword, needsRehash, temporaryPassword, minLength, isStaff, MAX_LENGTH };
