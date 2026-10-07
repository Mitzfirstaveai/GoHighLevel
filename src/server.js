const { loadConfig } = require('./config');
const { createApp } = require('./app');

const config = loadConfig();
const app = createApp(config);
app.listen(config.port, () => {
  console.log(`${config.orgName} app running at ${config.baseUrl} (payments: ${app.locals.gateway.mode})`);
});
