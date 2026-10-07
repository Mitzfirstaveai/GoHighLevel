const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

const env = process.env;
const isProduction = env.NODE_ENV === 'production';

function loadConfig(overrides = {}) {
  const port = Number(env.PORT) || 3000;
  const config = {
    isProduction,
    port,
    // RENDER_EXTERNAL_URL is provided automatically when hosted on Render.
    baseUrl: (env.BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    // Demo site: loads sample data into an empty database, shows one-tap demo sign-in
    // buttons, and gives admins a "Reset demo data" button.
    demoMode: env.DEMO_MODE === 'true',
    orgName: env.ORG_NAME || 'Gujarati Samaj of Arkansas',
    currency: (env.CURRENCY || 'usd').toLowerCase(),
    databaseFile: env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'samaj.db'),
    // Uploaded event/news photos. Lives next to the database so one disk holds all data.
    uploadsDir: env.UPLOADS_DIR || '',
    sessionSecret: env.SESSION_SECRET || 'dev-only-secret-change-me',
    adminEmail: env.ADMIN_EMAIL || '',
    adminPassword: env.ADMIN_PASSWORD || '',
    stripeSecretKey: env.STRIPE_SECRET_KEY || '',
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    // Demo payments let you try the full flow without Stripe. Never on in production
    // unless explicitly enabled.
    allowDemoPayments: env.ALLOW_DEMO_PAYMENTS
      ? env.ALLOW_DEMO_PAYMENTS === 'true'
      : !isProduction,
    ...overrides,
  };
  if (!config.uploadsDir) {
    config.uploadsDir = config.databaseFile === ':memory:'
      ? path.join(require('node:os').tmpdir(), 'samaj-uploads')
      : path.join(path.dirname(config.databaseFile), 'uploads');
  }
  // Members' photo albums are kept apart from the public uploads folder and served only to signed-in members.
  if (!config.photosDir) {
    config.photosDir = env.PHOTOS_DIR || (config.databaseFile === ':memory:'
      ? path.join(require('node:os').tmpdir(), 'samaj-photos')
      : path.join(path.dirname(config.databaseFile), 'photos'));
  }
  if (config.isProduction && config.sessionSecret === 'dev-only-secret-change-me') {
    throw new Error('SESSION_SECRET must be set in production');
  }
  return config;
}

module.exports = { loadConfig };
