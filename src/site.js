// Website content (About, Contact & organization details, Committee, Sponsors). Defaults come
// from content.js; admins can edit them in the app and the edits are stored in the `pages` table.
const defaults = require('./content');

const KEYS = {
  org: defaults.ORG,
  about: defaults.ABOUT,
  about_gu: defaults.ABOUT_GU,
  committee: defaults.COMMITTEE,
  sponsors: defaults.SPONSORS,
  news_filter: defaults.NEWS_FILTER,
};

function getContent(db, key) {
  const row = db.prepare('SELECT value FROM pages WHERE key = ?').get(key);
  if (!row) return KEYS[key];
  try {
    return key === 'org' ? { ...KEYS.org, ...JSON.parse(row.value) } : JSON.parse(row.value);
  } catch {
    return KEYS[key];
  }
}

function setContent(db, key, value) {
  if (!(key in KEYS)) throw new Error(`Unknown content key ${key}`);
  db.prepare(`INSERT INTO pages (key, value, updated_at) VALUES (?, ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, JSON.stringify(value));
}

module.exports = { getContent, setContent };
