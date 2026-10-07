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
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    orgName: env.ORG_NAME || 'Gujarati Samaj of Arkansas',
    currency: (env.CURRENCY || 'usd').toLowerCase(),
    databaseFile: env.DATABASE_FILE || path.join(__dirname, '..', 'data', 'samaj.db'),
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
  if (config.isProduction && config.sessionSecret === 'dev-only-secret-change-me') {
    throw new Error('SESSION_SECRET must be set in production');
  }
  return config;
}

module.exports = { loadConfig };
