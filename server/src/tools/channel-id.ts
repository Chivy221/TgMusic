/**
 * Печатает id канала, в котором бот админ.
 *
 * Запуск: npm run channel-id -w @telemusic/server
 * Дальше просто опубликуй в канале любое сообщение — id появится в консоли.
 *
 * Токен читаем отдельно от config: остальные переменные на этом шаге ещё не заполнены.
 */
import { readBotToken } from '../env.js';
import { Bot } from 'grammy';

let token: string;
try {
  token = readBotToken();
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const bot = new Bot(token);

bot.on('channel_post', (ctx) => {
  console.log('');
  console.log(`  Канал:  ${ctx.chat.title}`);
  console.log(`  id:     ${ctx.chat.id}`);
  console.log('');
  console.log('  Скопируй id в STORAGE_CHANNEL_ID и останови скрипт (Ctrl+C).');
});

bot.on('my_chat_member', (ctx) => {
  const { chat, new_chat_member } = ctx.myChatMember;
  console.log(`Статус в «${chat.title ?? chat.id}» (${chat.id}): ${new_chat_member.status}`);
});

bot.start({
  drop_pending_updates: true,
  onStart: (me) => console.log(`@${me.username} слушает. Опубликуй что-нибудь в канале-хранилище.`),
}).catch((error) => {
  if (error?.error_code === 401) {
    console.error('\nTelegram отклонил токен (401 Unauthorized). Проверь BOT_TOKEN в .env — возможно, он отозван.\n');
    process.exit(1);
  }
  throw error;
});
