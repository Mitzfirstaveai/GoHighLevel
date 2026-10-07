const session = require('express-session');

const DAY = 24 * 60 * 60 * 1000;

// Minimal express-session store backed by the app's SQLite database.
class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.lastPrune = 0;
  }

  get(sid, cb) {
    try {
      const row = this.db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?').get(sid);
      cb(null, row && row.expires > Date.now() ? JSON.parse(row.sess) : null);
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb = () => {}) {
    try {
      const expires = sess.cookie?.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + DAY;
      this.db.prepare('INSERT OR REPLACE INTO sessions (sid, sess, expires) VALUES (?, ?, ?)')
        .run(sid, JSON.stringify(sess), expires);
      this.prune();
      cb(null);
    } catch (err) { cb(err); }
  }

  touch(sid, sess, cb) { this.set(sid, sess, cb); }

  destroy(sid, cb = () => {}) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (err) { cb(err); }
  }

  prune() {
    if (Date.now() - this.lastPrune < 60 * 60 * 1000) return;
    this.lastPrune = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  }
}

module.exports = { SqliteStore };
