import express from 'express';
import { db } from './db.js';
import { router } from './routes.js';
import { trackApiRequest } from './maintenance.js';

export function createApp() {
  const app = express();
  app.use('/api/admin/printing/assets',express.json({limit:'3mb'}));
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = buffer.toString('utf8'); } }));
  app.use('/api', trackApiRequest, router);
  app.get('/api/health', (_req, res) => { try { db.prepare('SELECT 1').get();res.json({ok:true,service:'echo-hx-live-bar-api',time:new Date().toISOString()}); } catch {res.status(503).json({ok:false,service:'echo-hx-live-bar-api'});} });
  app.use((error, _req, res, _next) => {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    res.status(status).json({ message: status >= 500 ? '服务暂时不可用，请稍后重试' : error.message });
  });
  return app;
}
