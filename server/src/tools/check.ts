/**
 * Диагностика настройки: npm run check -w @telemusic/server
 *
 * Проверяет токен, канал-хранилище и права бота в нём — то есть всё, что иначе
 * всплывает уже в рантайме невнятной ошибкой Telegram.
 */
import { spawn } from 'node:child_process';
import { readBotToken, readChannelId, readWebappUrl } from '../env.js';
import { Bot } from 'grammy';

const ok = (text: string) => console.log(`  ✓ ${text}`);
const fail = (text: string) => console.log(`  ✗ ${text}`);
const warn = (text: string) => console.log(`  ! ${text}`);

let failed = false;

function section(title: string) {
  console.log(`\n${title}`);
}

section('Переменные окружения');

let token: string;
let channelId: number;
try {
  token = readBotToken();
  ok('BOT_TOKEN заполнен');
  channelId = readChannelId();
  ok(`STORAGE_CHANNEL_ID = ${channelId}`);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

try {
  ok(`WEBAPP_URL = ${readWebappUrl()}`);
} catch (error) {
  warn(error instanceof Error ? error.message.split('\n')[0] : String(error));
  warn('Без него мини-апп не откроется, но бот и канал уже проверяемы.');
}

const bot = new Bot(token);

section('Бот');

let botId: number;
try {
  const me = await bot.api.getMe();
  botId = me.id;
  ok(`@${me.username} (id ${me.id})`);
  if (!me.supports_inline_queries) {
    warn('Inline-режим выключен. Включи в @BotFather: /setinline');
  } else {
    ok('inline-режим включён');
  }

  // Без этого в группе бот видит только команды — музыку из чата-источника не заберёт.
  if (!me.can_read_all_group_messages) {
    warn('Privacy mode включён: в группах бот увидит только команды.');
    warn('Чтобы забирать музыку из групп: @BotFather → /setprivacy → Disable.');
    warn('Либо делай бота администратором в каждой такой группе.');
  } else {
    ok('privacy mode выключен — видит сообщения в группах');
  }
} catch (error) {
  fail(`Telegram отклонил токен: ${describe(error)}`);
  process.exit(1);
}

section('Канал-хранилище');

try {
  const chat = await bot.api.getChat(channelId);
  ok(`«${'title' in chat ? chat.title : channelId}», тип: ${chat.type}`);

  if (chat.type !== 'channel') {
    warn('Ожидался канал. Группа тоже заработает, но канал удобнее: нет лишних участников.');
  }

  const member = await bot.api.getChatMember(channelId, botId);
  if (member.status !== 'administrator') {
    fail(`Бот в канале имеет статус «${member.status}» — нужен администратор.`);
    failed = true;
  } else {
    ok('бот — администратор');

    if (member.can_post_messages) ok('право публиковать есть');
    else {
      fail('нет права публиковать — треки не попадут в хранилище');
      failed = true;
    }

    if (member.can_delete_messages) ok('право удалять есть');
    else {
      warn('нет права удалять — плейлист в канале пользователя не будет перезаписываться');
    }
  }
} catch (error) {
  fail(`Не читается канал ${channelId}: ${describe(error)}`);
  console.log('    Проверь, что id скопирован целиком (с «-100») и бот добавлен в канал.');
  failed = true;
}

section('Загрузка по ссылке');

// Без этих двоих импорт по ссылке остаётся подбором по каталогу: разберёт
// трек-лист, найдёт совпадения, но скачать недостающее будет нечем.
for (const [name, argv] of [
  ['yt-dlp', [process.env.YTDLP_PATH ?? 'yt-dlp', '--version']],
  ['ffmpeg', ['ffmpeg', '-version']],
] as const) {
  const version = await probe(argv);
  if (version) ok(`${name} — ${version}`);
  else warn(`${name} не найден: скачивание по ссылке будет выключено`);
}

console.log('');
console.log(failed ? 'Есть проблемы — см. отметки ✗ выше.' : 'Всё готово.');
process.exit(failed ? 1 : 0);

function probe(argv: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';

    child.stdout.on('data', (chunk) => (out += chunk));
    child.on('error', () => resolve(null));
    child.on('close', (code) =>
      resolve(code === 0 ? (out.trim().split('\n')[0]?.slice(0, 60) ?? '') : null),
    );
  });
}

function describe(error: unknown): string {
  if (error && typeof error === 'object' && 'description' in error) {
    return String((error as { description: unknown }).description);
  }
  return error instanceof Error ? error.message : String(error);
}
