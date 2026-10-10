// The shared door login: one username ("door") and a short, simple password the committee sets and gives to
// everyone helping at the door, so volunteers don't each need their own account. It opens only door check-in
// (search, scan, see who has paid, check in); volunteers don't handle money. Each person types their first name
// after signing in, and that name is kept with every check-in they record. Changing the password (or turning
// the login off) signs out every phone using it.
const { hashPassword } = require('./passwords');
const { UserError } = require('./services');

const USERNAME = 'door';
// The account behind it: a user row that never appears among members or contacts (contact_type 'door').
const ACCOUNT = { email: USERNAME, first_name: 'Door', last_name: 'volunteers' };

const doorAccount = (db) => db.prepare(`SELECT * FROM users WHERE contact_type = 'door'`).get() || null;
const isDoorAccount = (user) => user?.contact_type === 'door';

function signOutDoorPhones(db, id) {
  db.prepare(`DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?`).run(id);
}

// The door password only has to be easy to share out loud: 4 or more characters, anything goes (e.g. "garba25").
// It can't reach member details or money, wrong guesses pause sign-in, and it can be changed after each event.
const DOOR_MIN_LENGTH = 4;

// Sets (or changes) the password and turns the login on.
function setDoorPassword(db, password) {
  const pw = String(password || '');
  if (pw.length < DOOR_MIN_LENGTH) throw new UserError('The door password must be at least {n} characters.', { n: DOOR_MIN_LENGTH });
  if (pw.length > 64) throw new UserError('Password is too long (at most {n} characters).', { n: 64 });
  const existing = doorAccount(db);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, password_temporary = 0, checkin_access = 1 WHERE id = ?').run(hashPassword(password), existing.id);
    signOutDoorPhones(db, existing.id);
    return existing.id;
  }
  return Number(db.prepare(`INSERT INTO users (email, password_hash, role, first_name, last_name, contact_type, checkin_access, source)
    VALUES (?, ?, 'member', ?, ?, 'door', 1, 'admin')`).run(ACCOUNT.email, hashPassword(password), ACCOUNT.first_name, ACCOUNT.last_name).lastInsertRowid);
}

function turnOffDoorLogin(db) {
  const account = doorAccount(db);
  if (!account) return;
  db.prepare('UPDATE users SET checkin_access = 0 WHERE id = ?').run(account.id);
  signOutDoorPhones(db, account.id);
}

// The first name a volunteer gives after signing in with the shared login.
function cleanVolunteerName(value) {
  const name = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]*$/u.test(name)) throw new UserError('Please type your first name.');
  return name;
}

module.exports = { USERNAME, DOOR_MIN_LENGTH, doorAccount, isDoorAccount, setDoorPassword, turnOffDoorLogin, cleanVolunteerName };
