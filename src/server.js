const { loadConfig } = require('./config');
const { createApp } = require('./app');

const config = loadConfig();
const app = createApp(config);
// Gujarat & India news: fetch new headlines every hour (NEWS_REFRESH_MINUTES=0 turns this off).
require('./newsfeed').startNewsRefresh(app.locals.db, config.newsRefreshMinutes);
// Event reminders on members' devices: checked every few minutes (REMINDER_MINUTES=0 turns this off).
require('./reminders').startReminders(app.locals.db, config);
app.listen(config.port, () => {
  console.log(`${config.orgName} app running at ${config.baseUrl} (payments: ${app.locals.gateway.mode})`);
});
