import express from 'express';
import './db.js';
import { router } from './routes.js';

const app = express();
const port = process.env.PORT || 3001;
const host = process.env.HOST || '127.0.0.1';

app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = buffer.toString('utf8'); } }));
app.use('/api', router);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'echo-hx-live-bar-api', time: new Date().toISOString() });
});

app.get('/api/dashboard/summary', (_req, res) => {
  res.json({ todayRevenue: 28460, activeOrders: 12, tableUsage: 72.3, membersAdded: 248 });
});

const server = app.listen(port, host, () => {
  console.log(`Echo HX API listening on http://${host}:${port}`);
});

const shutdown = signal => {
  console.log(`${signal}: shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
