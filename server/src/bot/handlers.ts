import { InlineKeyboard, InlineQueryResultBuilder } from 'grammy';
import { bot } from './bot.js';
import { config } from '../config.js';
import { ensureUser, ingestAudio, searchTracks, setPlaybackChat } from '../services/catalog.js';
import { getUserByPlaybackChat } from '../services/lookup.js';

const openApp = new InlineKeyboard().webApp('🎧 Открыть плеер', config.webappUrl);

bot.command('start', async (ctx) => {
  ensureUser(ctx.from!.id, ctx.from!.username, ctx.from!.first_name);

  await ctx.reply(
    [
      'Привет! Это твоя фонотека в Telegram.',
      '',
      '1. Кидай сюда любые аудиофайлы — они попадут в библиотеку.',
      '2. В плеере собирай из них плейлисты и публикуй их.',
      '',
      'Чтобы слушать штатным плеером Telegram (фон, экран блокировки, кэш), нужен канал:',
      '• создай приватный канал, например «Моя музыка»',
      '• добавь меня туда админом с правом публикации и удаления',
      'После этого в плеере появится кнопка «Слушать».',
    ].join('\n'),
    { reply_markup: openApp },
  );
});

bot.command('help', (ctx) => ctx.reply('Кидай аудио сюда, собирай плейлисты в плеере.', { reply_markup: openApp }));

/** Аудио в личке — основной способ пополнить библиотеку. */
bot.on('message:audio', async (ctx) => {
  const audio = ctx.message.audio;
  ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);

  try {
    const { track, isNew } = await ingestAudio(
      {
        fileId: audio.file_id,
        fileUniqueId: audio.file_unique_id,
        title: audio.title,
        performer: audio.performer,
        duration: audio.duration,
        fileSize: audio.file_size,
      },
      ctx.from.id,
    );

    const name = [track.performer, track.title].filter(Boolean).join(' — ') || 'Трек';
    await ctx.reply(isNew ? `Добавлено: ${name}` : `Уже есть в каталоге: ${name}`, {
      reply_markup: openApp,
    });
  } catch (error) {
    console.error('[ingest] ошибка', error);
    await ctx.reply('Не получилось добавить трек. Проверь, что бот админ в канале-хранилище.');
  }
});

/** Файл, отправленный как документ, Telegram аудио не считает — подсказываем. */
bot.on('message:document', async (ctx) => {
  if (ctx.message.document.mime_type?.startsWith('audio/')) {
    await ctx.reply('Этот файл пришёл как документ. Отправь его как аудио — тогда он попадёт в фонотеку.');
  }
});

/** Бота сделали админом канала — считаем этот канал сценой для воспроизведения. */
bot.on('my_chat_member', async (ctx) => {
  const update = ctx.myChatMember;
  if (update.chat.type !== 'channel') return;

  const status = update.new_chat_member.status;
  const userId = update.from.id;
  ensureUser(userId, update.from.username, update.from.first_name);

  if (status === 'administrator') {
    setPlaybackChat(userId, update.chat.id);
    await notify(userId, `Канал «${update.chat.title}» подключён. Теперь в плеере работает кнопка «Слушать».`);
  } else if (status === 'left' || status === 'kicked') {
    setPlaybackChat(userId, null);
    await notify(userId, 'Канал отключён — воспроизведение больше недоступно.');
  }
});

/** Аудио, брошенное прямо в подключённый канал, тоже попадает в библиотеку. */
bot.on('channel_post:audio', async (ctx) => {
  const audio = ctx.channelPost.audio;
  const owner = getUserByPlaybackChat(ctx.chat.id);
  if (!owner) return;

  try {
    await ingestAudio(
      {
        fileId: audio.file_id,
        fileUniqueId: audio.file_unique_id,
        title: audio.title,
        performer: audio.performer,
        duration: audio.duration,
        fileSize: audio.file_size,
      },
      owner.id,
    );
  } catch (error) {
    console.error('[ingest:channel] ошибка', error);
  }
});

/**
 * Inline-режим: `@бот queen` в любом чате отправляет трек прямо туда.
 * Работает по file_id, то есть мгновенно и без трафика через нас.
 */
bot.on('inline_query', async (ctx) => {
  const query = ctx.inlineQuery.query.trim();
  if (query.length < 2) return ctx.answerInlineQuery([], { cache_time: 5 });

  const results = searchTracks(query, 25).map((track) =>
    InlineQueryResultBuilder.audioCached(String(track.id), track.fileId),
  );

  await ctx.answerInlineQuery(results, { cache_time: 60, is_personal: false });
});

bot.catch((error) => console.error('[bot] необработанная ошибка', error));

async function notify(userId: number, text: string): Promise<void> {
  try {
    await bot.api.sendMessage(userId, text, { reply_markup: openApp });
  } catch {
    // Пользователь мог не открывать личку с ботом — не страшно.
  }
}
