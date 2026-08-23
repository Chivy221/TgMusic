import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { config } from './config.js';
import { migrate } from './db/index.js';
import { api } from './api/routes.js';
import { bot } from './bot/bot.js';
import { COMMANDS } from './bot/handlers.js';

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
    onStart: async (me) => {
      console.log(`Бот @${me.username} запущен`);
      await publishCommands();
    },
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      console.log('Останавливаюсь...');
      void bot.stop();
      process.exit(0);
    });
  }
}

/**
 * Команды и кнопка меню задаются на стороне Telegram и живут до следующей записи.
 * Пишем их при каждом старте: иначе после правки списка в коде в переписке
 * остаётся прошлый — а пустое меню выглядит как бот, который ничего не умеет.
 */
async function publishCommands(): Promise<void> {
  try {
    await bot.api.setMyCommands(COMMANDS);

    // В группах из этого списка осмысленны только /player и /help — остальное
    // относится к личной фонотеке и в общем чате только мешает.
    await bot.api.setMyCommands(
      COMMANDS.filter((command) => ['player', 'help'].includes(command.command)),
      { scope: { type: 'all_group_chats' } },
    );

    await bot.api.setChatMenuButton({ menu_button: { type: 'commands' } });
    console.log(`Команды опубликованы: ${COMMANDS.map((c) => `/${c.command}`).join(' ')}`);
  } catch (error) {
    console.error('[bot] не удалось опубликовать команды', error);
  }
}
