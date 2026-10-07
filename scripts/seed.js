// Loads the demo data set (members on every level, events, RSVPs, payments, check-ins).
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const { seedDemo, isEmpty, DEMO_PASSWORD, DEMO_ACCOUNTS } = require('../src/demo');

const config = loadConfig();
const db = openDb(config.databaseFile);
if (!isEmpty(db)) {
  console.log('Database already has users — skipping seed.');
  process.exit(0);
}
seedDemo(db, { photosDir: config.photosDir });
console.log(`Seeded demo data. Sign in as ${DEMO_ACCOUNTS.map((a) => a.email).join(' or ')} (password: ${DEMO_PASSWORD}).`);
