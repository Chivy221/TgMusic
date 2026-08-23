import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config } from './config.js';
import { migrate } from './db/index.js';
import { api } from './api/routes.js';
import { bot } from './bot/bot.js';
import './bot/handlers.js';

export function start(): void {
  migrate();

  const app = new Hono();
  app.use('/api/*', cors());
  app.route('/api', api);
  app.get('/health', (c) => c.json({ ok: true }));

  // Собранный мини-апп. В разработке фронт обычно поднят отдельно на Vite.
  app.use('/*', serveStatic({ root: '../miniapp/dist' }));
  app.get('/*', serveStatic({ path: '../miniapp/dist/index.html' }));

  serve({ fetch: app.fetch, port: config.port }, (info) => {
    console.log(`API слушает http://localhost:${info.port}`);
  });

  bot.start({
    drop_pending_updates: true,
    onStart: (me) => console.log(`Бот @${me.username} запущен`),
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.log('Останавливаюсь...');
      void bot.stop();
      process.exit(0);
    });
  }
}
