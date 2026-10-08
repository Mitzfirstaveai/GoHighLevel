const { loadConfig } = require('./config');
const { createApp } = require('./app');

const config = loadConfig();
const app = createApp(config);
// Gujarat & India news: fetch new headlines every hour (NEWS_REFRESH_MINUTES=0 turns this off).
require('./newsfeed').startNewsRefresh(app.locals.db, config.newsRefreshMinutes);
app.listen(config.port, () => {
  console.log(`${config.orgName} app running at ${config.baseUrl} (payments: ${app.locals.gateway.mode})`);
});
