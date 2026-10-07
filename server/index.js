import { createApp } from './app.js';
import { startBusinessSchedulers } from './routes.js';
import { startBackupScheduler } from './backup.js';

const app = createApp();
const port = process.env.PORT || 3001;
const host = process.env.HOST || '127.0.0.1';

const stopBusinessSchedulers = startBusinessSchedulers();
const server = app.listen(port, host, () => {
  console.log(`Echo HX API listening on http://${host}:${port}`);
  startBackupScheduler();
});

const shutdown = signal => {
  console.log(`${signal}: shutting down`);
  stopBusinessSchedulers();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
