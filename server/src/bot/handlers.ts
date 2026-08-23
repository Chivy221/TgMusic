import { InlineKeyboard, InlineQueryResultBuilder, type Context } from 'grammy';
import { bot } from './bot.js';
import { config } from '../config.js';
import { ensureUser, ingestAudio, searchTracks, setPlaybackChat } from '../services/catalog.js';
import { getUserByPlaybackChat } from '../services/lookup.js';
import {
  addTrack,
  createLinkedPlaylist,
  findBySourceChat,
  getPlaylist,
  renamePlaylist,
} from '../services/playlists.js';
import { attachDraft, clearDraft, finishDraft, getDraft, nameDraft, startDraft } from '../services/drafts.js';
import type { IncomingAudio } from '../services/catalog.js';

const openApp = new InlineKeyboard().webApp('🎛 Открыть настройки', config.webappUrl);

const HELP = [
  'Это твоя фонотека в Telegram.',
  '',
  'Собрать плейлист прямо здесь:',
  '/new — начать, дальше кидай аудио, в конце /done',
  '/cancel — отменить',
  '',
  'Забрать музыку из своей группы:',
  'добавь меня в неё — я предложу сделать из неё плейлист.',
  'Прошлые сообщения я прочитать не могу, их нужно переслать сюда.',
  '',
  'Чтобы слушать, нужна группа-плеер: создай отдельную группу,',
  'добавь меня админом и отключи в ней уведомления.',
].join('\n');

bot.command('start', async (ctx) => {
  ensureUser(ctx.from!.id, ctx.from!.username, ctx.from!.first_name);
  await ctx.reply(HELP, { reply_markup: openApp });
});

bot.command('help', (ctx) => ctx.reply(HELP, { reply_markup: openApp }));

bot.command('new', async (ctx) => {
  ensureUser(ctx.from!.id, ctx.from!.username, ctx.from!.first_name);
  startDraft(ctx.from!.id);
  await ctx.reply('Как назовём плейлист? Пришли название одним сообщением.');
});

bot.command('done', async (ctx) => {
  const finished = finishDraft(ctx.from!.id);

  if (!finished) {
    await ctx.reply('Сейчас ничего не собирается. Начать — /new');
    return;
  }

  const playlist = getPlaylist(finished.playlistId);
  await ctx.reply(
    finished.count === 0
      ? `Плейлист «${playlist?.title}» пуст — треки можно добавить в настройках.`
      : `Готово: «${playlist?.title}», треков — ${finished.count}.`,
    { reply_markup: openApp },
  );
});

bot.command('cancel', async (ctx) => {
  clearDraft(ctx.from!.id);
  await ctx.reply('Сбор остановлен. Треки остались в библиотеке.');
});

/** Название плейлиста ждём ровно одним сообщением сразу после /new. */
bot.on('message:text', async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  if (ctx.message.text.startsWith('/')) return next();

  const draft = getDraft(ctx.from.id);
  if (draft?.stage !== 'awaiting_title') return next();

  const playlistId = nameDraft(ctx.from.id, ctx.message.text);
  await ctx.reply(
    `Плейлист «${getPlaylist(playlistId)?.title}» создан. Кидай аудио, в конце — /done`,
  );
});

/** Аудио в личке: в библиотеку всегда, в собираемый плейлист — если идёт сбор. */
bot.on('message:audio', async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();

  ensureUser(ctx.from.id, ctx.from.username, ctx.from.first_name);

  try {
    const { track, isNew } = await ingestAudio(toIncoming(ctx.message.audio), ctx.from.id);
    const name = [track.performer, track.title].filter(Boolean).join(' — ') || 'Трек';
    const draft = getDraft(ctx.from.id);

    if (draft?.stage === 'collecting' && draft.playlistId) {
      addTrack(draft.playlistId, track.id);
      await ctx.reply(`+ ${name}`);
      return;
    }

    await ctx.reply(isNew ? `Добавлено: ${name}` : `Уже есть в каталоге: ${name}`, {
      reply_markup: openApp,
    });
  } catch (error) {
    console.error('[ingest] ошибка', error);
    await ctx.reply('Не получилось добавить трек. Проверь, что бот админ в канале-хранилище.');
  }
});

/** Аудио в группе-источнике дописывается в связанный плейлист, сохраняя порядок. */
bot.on('message:audio', async (ctx) => {
  const playlist = findBySourceChat(ctx.chat.id);
  if (!playlist || playlist.syncEnabled === 0) return;

  try {
    const { track } = await ingestAudio(toIncoming(ctx.message.audio), playlist.ownerId);
    addTrack(playlist.id, track.id);
  } catch (error) {
    console.error('[sync:group] ошибка', error);
  }
});

/** Группу переименовали — подтягиваем название в связанный плейлист. */
bot.on('message:new_chat_title', async (ctx) => {
  const playlist = findBySourceChat(ctx.chat.id);
  if (!playlist || playlist.syncEnabled === 0) return;

  renamePlaylist(playlist, ctx.message.new_chat_title);
});

bot.on('message:document', async (ctx) => {
  if (ctx.chat.type !== 'private') return;
  if (ctx.message.document.mime_type?.startsWith('audio/')) {
    await ctx.reply('Файл пришёл как документ. Отправь его как аудио — тогда он попадёт в фонотеку.');
  }
});

/**
 * Бота добавили в группу или канал. Роль неоднозначна — это может быть и плеер,
 * и склад музыки, — поэтому спрашиваем прямо, а не угадываем.
 */
bot.on('my_chat_member', async (ctx) => {
  const update = ctx.myChatMember;
  const type = update.chat.type;
  const status = update.new_chat_member.status;
  const userId = update.from.id;

  if (type === 'private') return;
  ensureUser(userId, update.from.username, update.from.first_name);

  if (status === 'left' || status === 'kicked') {
    const owner = getUserByPlaybackChat(update.chat.id);
    if (owner) {
      setPlaybackChat(owner.id, null);
      await notify(owner.id, 'Группа-плеер отключена.');
    }
    return;
  }

  if (status !== 'administrator' && status !== 'member') return;

  const title = 'title' in update.chat ? update.chat.title : 'без названия';
  const keyboard = new InlineKeyboard()
    .text('🎧 Это плеер', `role:player:${update.chat.id}`)
    .row()
    .text('📥 Сделать плейлист отсюда', `role:source:${update.chat.id}`);

  await notify(
    userId,
    [
      `Добавлен в «${title}». Для чего эта группа?`,
      '',
      '🎧 Плеер — сюда я буду выкладывать плейлисты для прослушивания.',
      '📥 Источник — сделаю плейлист с названием группы и буду дописывать в него новые треки.',
    ].join('\n'),
    keyboard,
  );
});

bot.on('callback_query:data', async (ctx) => {
  const [action, ...rest] = ctx.callbackQuery.data.split(':');

  if (action === 'role') {
    const [role, rawChatId] = rest;
    await handleRole(ctx, role, Number(rawChatId));
    return;
  }

  if (action === 'import') {
    const playlistId = Number(rest[0]);
    const playlist = getPlaylist(playlistId);

    if (!playlist || playlist.ownerId !== ctx.from.id) {
      await ctx.answerCallbackQuery('Плейлист не найден');
      return;
    }

    attachDraft(ctx.from.id, playlistId);
    await ctx.answerCallbackQuery('Жду пересылку');
    await ctx.reply(
      [
        `Пересылай сюда музыку — всё пойдёт в «${playlist.title}» по порядку.`,
        '',
        'В Telegram можно выделить до 100 сообщений разом: зажми первое,',
        'отметь остальные и нажми «Переслать».',
        '',
        'Когда закончишь — /done',
      ].join('\n'),
    );
    return;
  }

  await ctx.answerCallbackQuery();
});

async function handleRole(ctx: Context, role: string, chatId: number): Promise<void> {
  if (!ctx.from) return;

  // Роль назначает только владелец или админ группы — иначе чужой участник
  // мог бы привязать её к себе.
  try {
    const member = await bot.api.getChatMember(chatId, ctx.from.id);
    if (member.status !== 'creator' && member.status !== 'administrator') {
      await ctx.answerCallbackQuery('Так может только администратор группы');
      return;
    }
  } catch {
    await ctx.answerCallbackQuery('Не удалось проверить права');
    return;
  }

  if (role === 'player') {
    setPlaybackChat(ctx.from.id, chatId);
    await ctx.answerCallbackQuery('Плеер подключён');
    await ctx.reply(
      [
        'Готово, это теперь плеер.',
        '',
        'Дай мне права администратора — без них я не смогу убирать прошлый плейлист.',
        'И отключи в группе уведомления: треки я шлю без звука, но список чатов будет прыгать.',
      ].join('\n'),
      { reply_markup: openApp },
    );
    return;
  }

  if (role !== 'source') {
    await ctx.answerCallbackQuery();
    return;
  }

  const existing = findBySourceChat(chatId);
  if (existing) {
    await ctx.answerCallbackQuery('Уже связано');
    await ctx.reply(`Эта группа уже связана с плейлистом «${existing.title}».`, {
      reply_markup: openApp,
    });
    return;
  }

  const chat = await bot.api.getChat(chatId);
  const title = 'title' in chat ? (chat.title ?? 'Без названия') : 'Без названия';
  const playlist = createLinkedPlaylist(ctx.from.id, title, chatId);

  await ctx.answerCallbackQuery('Плейлист создан');
  await ctx.reply(
    [
      `Плейлист «${playlist.title}» создан и связан с группой.`,
      '',
      'Всё новое, что появится в группе, я буду дописывать сюда автоматически.',
      '',
      '⚠️ Прошлые сообщения группы я прочитать не могу — Telegram не даёт ботам',
      'доступ к истории. Чтобы перенести старое, перешли его мне.',
    ].join('\n'),
    {
      reply_markup: new InlineKeyboard().text('📤 Перешлю сейчас', `import:${playlist.id}`),
    },
  );
}

/** Аудио, брошенное прямо в подключённый канал, тоже попадает в библиотеку. */
bot.on('channel_post:audio', async (ctx) => {
  const linked = findBySourceChat(ctx.chat.id);
  const owner = linked ? { id: linked.ownerId } : getUserByPlaybackChat(ctx.chat.id);
  if (!owner) return;

  try {
    const { track } = await ingestAudio(toIncoming(ctx.channelPost.audio), owner.id);
    if (linked && linked.syncEnabled === 1) addTrack(linked.id, track.id);
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

function toIncoming(audio: {
  file_id: string;
  file_unique_id: string;
  title?: string;
  performer?: string;
  duration: number;
  file_size?: number;
}): IncomingAudio {
  return {
    fileId: audio.file_id,
    fileUniqueId: audio.file_unique_id,
    title: audio.title,
    performer: audio.performer,
    duration: audio.duration,
    fileSize: audio.file_size,
  };
}

async function notify(userId: number, text: string, keyboard = openApp): Promise<void> {
  try {
    await bot.api.sendMessage(userId, text, { reply_markup: keyboard });
  } catch {
    // Пользователь мог не открывать личку с ботом — не страшно.
  }
}
