import { InlineKeyboard, InlineQueryResultBuilder, type Context } from 'grammy';
import { bot } from './bot.js';
import { config } from '../config.js';
import {
  ensureUser,
  getUser,
  ingestAudio,
  searchTracks,
  setPlaybackChat,
} from '../services/catalog.js';
import { getUserByPlaybackChat } from '../services/lookup.js';
import {
  addTrack,
  createLinkedPlaylist,
  findBySourceChat,
  getPlaylist,
  renamePlaylist,
} from '../services/playlists.js';
import { attachDraft, clearDraft, finishDraft, getDraft, nameDraft, startDraft } from '../services/drafts.js';
import { isGone, linkUserToChat, listUserChats, rememberChat } from '../services/chats.js';
import { importFromLink, looksLikeLink, type ImportResult } from '../services/import.js';
import { applyVariants } from '../services/variants.js';
import { applyOverrides } from '../services/overrides.js';
import { clearPlayerChat } from '../services/player.js';
import { getJob, startDownload, type DownloadJob } from '../services/downloads.js';
import { AppError, slug, sleep } from '../utils.js';
import type { IncomingAudio } from '../services/catalog.js';

const openApp = new InlineKeyboard().webApp('🎛 Открыть настройки', config.webappUrl);

/**
 * Список команд для меню Telegram. Без setMyCommands кнопка «≡» в переписке пуста
 * и подсказки при вводе «/» не появляются — команды знает только тот, кто их видел.
 */
export const COMMANDS = [
  { command: 'app', description: 'Открыть фонотеку' },
  { command: 'new', description: 'Собрать плейлист: дальше кидай аудио' },
  { command: 'done', description: 'Закончить сбор плейлиста' },
  { command: 'cancel', description: 'Отменить сбор' },
  { command: 'link', description: 'Добавить по ссылке с другой площадки' },
  { command: 'player', description: 'Какая группа сейчас плеер' },
  { command: 'help', description: 'Что я умею' },
];

const HELP = [
  'Это твоя фонотека в Telegram.',
  '',
  'Кидай мне аудио — оно попадёт в библиотеку.',
  'Кидай ссылку с Deezer, Apple Music, Spotify, YouTube или SoundCloud —',
  'соберу по ней трек, альбом или плейлист.',
  '',
  'Команды:',
  '/app — фонотека, плейлисты и настройки',
  '/new — собрать плейлист прямо здесь, в конце /done',
  '/link — добавить по ссылке',
  '/player — какая группа сейчас плеер',
  '',
  'Чтобы слушать, нужна группа-плеер: создай группу, добавь меня',
  'админом и выбери её плеером в разделе «Библиотека».',
].join('\n');

/**
 * Любое сообщение из группы говорит, что бот там есть, а его автор — что человек
 * тоже. Этого достаточно, чтобы группа появилась в списке для выбора плеера:
 * в группах privacy mode оставляет боту только команды, так что /player в нужной
 * группе — рабочий способ её туда добавить, даже если бота добавлял кто-то другой.
 */
bot.use(async (ctx, next) => {
  const chat = ctx.chat;
  if (chat && chat.type !== 'private') {
    rememberChat(chat);
    if (ctx.from && !ctx.from.is_bot) linkUserToChat(ctx.from.id, chat.id);
  }
  await next();
});

bot.command('start', async (ctx) => {
  ensureUser(ctx.from!.id, ctx.from!.username, ctx.from!.first_name);
  await ctx.reply(HELP, { reply_markup: openApp });
});

bot.command('help', (ctx) => ctx.reply(HELP, { reply_markup: openApp }));

bot.command('app', (ctx) => ctx.reply('Фонотека, плейлисты и настройки — здесь.', { reply_markup: openApp }));

bot.command('player', async (ctx) => {
  const user = ensureAndGet(ctx);
  const chats = listUserChats(ctx.from!.id);
  const current = chats.find((chat) => chat.isPlayer);

  if (!user?.playbackChatId || !current) {
    await ctx.reply(
      [
        'Плеер не выбран.',
        '',
        chats.length === 0
          ? 'Создай группу, добавь меня туда админом — и она появится в списке.'
          : `Группы, которые можно сделать плеером: ${chats.map((chat) => `«${chat.title}»`).join(', ')}.`,
        'Выбрать — в «Библиотеке» в настройках.',
      ].join('\n'),
      { reply_markup: openApp },
    );
    return;
  }

  await ctx.reply(
    [
      `Плеер: «${current.title}».`,
      current.isAdmin ? '' : '⚠️ Я там не администратор — прошлый плейлист убрать не смогу.',
    ]
      .filter(Boolean)
      .join('\n'),
    { reply_markup: openApp },
  );
});

bot.command('link', async (ctx) => {
  const url = ctx.match.trim();

  if (!url) {
    await ctx.reply(
      [
        'Пришли ссылку на трек, альбом или плейлист — разберу её и добавлю то,',
        'что уже есть в общем каталоге.',
        '',
        'Полный список треков отдают Deezer, Apple Music и Spotify.',
        'С YouTube и SoundCloud получится добавить один трек по ссылке на него.',
        'Яндекс Музыка без токена аккаунта не отдаёт ничего.',
        '',
        'Самих файлов у площадок не забрать — их отдаёт только тот, кто их залил.',
      ].join('\n'),
    );
    return;
  }

  await runImport(ctx, url);
});

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

/**
 * Ссылка в личке — это добавление с другой площадки.
 * Стоит после сбора названия плейлиста: если ждём имя, ссылка станет именем.
 */
bot.on('message:text', async (ctx, next) => {
  if (ctx.chat.type !== 'private') return next();
  if (!looksLikeLink(ctx.message.text)) return next();

  await runImport(ctx, ctx.message.text.trim());
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
  rememberChat({ ...ctx.chat, title: ctx.message.new_chat_title });

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
 * и склад музыки, — поэтому спрашиваем прямо, а не угадываем. Но и без ответа
 * группа запоминается: плеер выбирается списком в настройках в любой момент.
 */
bot.on('my_chat_member', async (ctx) => {
  const update = ctx.myChatMember;
  const type = update.chat.type;
  const member = update.new_chat_member;
  const status = member.status;
  const userId = update.from.id;
  const title = 'title' in update.chat ? (update.chat.title ?? 'без названия') : 'без названия';

  if (type === 'private') return;
  ensureUser(userId, update.from.username, update.from.first_name);

  rememberChat(
    { id: update.chat.id, type, title },
    status,
    status === 'administrator' && Boolean(member.can_delete_messages),
  );

  if (isGone(status)) {
    const owner = getUserByPlaybackChat(update.chat.id);
    if (owner) {
      setPlaybackChat(owner.id, null);
      await notify(owner.id, `Группа «${title}» больше не плеер — меня оттуда убрали.`);
    }
    return;
  }

  linkUserToChat(userId, update.chat.id);

  if (status !== 'administrator' && status !== 'member') return;

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
      '',
      'Можно не отвечать: группа уже в списке, плеер выбирается в «Библиотеке».',
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

  if (action === 'dl') {
    await runDownload(ctx, rest[0]);
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
    // Прошлый плеер вычищаем до переключения: после смены чата ссылки на выложенные
    // там сообщения теряются вместе с ним, и убрать их будет уже нечем.
    const previous = getUser(ctx.from.id)?.playbackChatId;
    if (previous && previous !== chatId) await clearPlayerChat(ctx.from.id);

    setPlaybackChat(ctx.from.id, chatId);
    linkUserToChat(ctx.from.id, chatId);

    await ctx.answerCallbackQuery('Плеер подключён');
    await ctx.reply(
      [
        'Готово, это теперь плеер.',
        '',
        'Дай мне права администратора — без них я не смогу убирать прошлый плейлист.',
        'И отключи в группе уведомления: треки я шлю без звука, но список чатов будет прыгать.',
        '',
        'Сменить плеер потом — в «Библиотеке» в настройках.',
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
 *
 * Результаты личные: у автора запроса могут быть свои названия и свои перезалитые
 * копии, поэтому кэш Telegram по этому запросу общим быть не должен.
 */
bot.on('inline_query', async (ctx) => {
  const query = ctx.inlineQuery.query.trim();
  if (query.length < 2) return ctx.answerInlineQuery([], { cache_time: 5 });

  const userId = ctx.from.id;
  const found = applyVariants(userId, applyOverrides(userId, searchTracks(query, 25)));
  const results = found.map((track) =>
    InlineQueryResultBuilder.audioCached(String(track.id), track.fileId),
  );

  await ctx.answerInlineQuery(results, { cache_time: 60, is_personal: true });
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

function ensureAndGet(ctx: Context) {
  ensureUser(ctx.from!.id, ctx.from!.username, ctx.from!.first_name);
  return getUser(ctx.from!.id);
}

/**
 * Разбор ссылки с площадки. Файлов оттуда не забрать — площадки отдают только
 * названия, — поэтому находим совпадения в общем каталоге и честно перечисляем,
 * чего не нашлось: иначе «добавил 3 из 20» выглядит как поломка.
 */
async function runImport(ctx: Context, url: string): Promise<void> {
  ensureAndGet(ctx);

  const userId = ctx.from!.id;
  const note = await ctx.reply('Разбираю ссылку…');
  const draft = getDraft(userId);
  const playlistId = draft?.stage === 'collecting' ? (draft.playlistId ?? undefined) : undefined;

  try {
    const result = await importFromLink(userId, url, playlistId);

    // Докачку не запускаем сами: она идёт минуты и гоняет файлы через сервер,
    // поэтому остаётся отдельным осознанным нажатием.
    const keyboard = result.canDownload
      ? new InlineKeyboard().text(
          `⬇ Скачать ${result.missing.length}`,
          `dl:${rememberLink(userId, url, playlistId)}`,
        )
      : openApp;

    await ctx.api.editMessageText(note.chat.id, note.message_id, describeImport(result, playlistId), {
      reply_markup: keyboard,
    });
  } catch (error) {
    await ctx.api.editMessageText(
      note.chat.id,
      note.message_id,
      error instanceof AppError ? error.message : 'Не получилось разобрать ссылку',
    );
  }
}

function describeImport(result: ImportResult, playlistId?: number): string {
  const kind = result.kind === 'track' ? 'Трек' : result.kind === 'album' ? 'Альбом' : 'Плейлист';
  const lines = [`${kind} «${result.name}» — ${result.source}.`, ''];

  if (result.found.length > 0) {
    lines.push(
      playlistId === undefined
        ? `Уже было в каталоге и добавлено: ${result.found.length}`
        : `Уже было в каталоге и добавлено в плейлист: ${result.found.length}`,
    );
  }

  if (result.missing.length > 0) {
    lines.push(`Нет в каталоге: ${result.missing.length}`);
    lines.push(
      ...result.missing
        .slice(0, 15)
        .map((item) => `· ${[item.performer, item.title].filter(Boolean).join(' — ')}`),
    );
    if (result.missing.length > 15) lines.push(`…и ещё ${result.missing.length - 15}`);
    lines.push('');
    lines.push(
      result.canDownload
        ? 'Могу найти их на YouTube и скачать — примерно полминуты на трек.'
        : 'Скачать не могу: на сервере нет yt-dlp. Пришли их мне аудио — появятся у всех.',
    );
  }

  if (result.partial) {
    lines.push('');
    lines.push('Полный список треков эта площадка без ключа не отдаёт — вышло только название.');
  }

  return lines.join('\n');
}

/**
 * Ссылка, под которую предложена загрузка.
 *
 * В callback_data влезает 64 байта — ссылка туда не помещается, поэтому в кнопку
 * кладём короткий ключ, а саму ссылку держим здесь. Это заодно и защита: цель для
 * загрузчика берётся из нашей памяти, а не из данных, пришедших с нажатием.
 */
const pending = new Map<string, { userId: number; url: string; playlistId?: number; at: number }>();

const PENDING_TTL_MS = 60 * 60 * 1000;

function rememberLink(userId: number, url: string, playlistId?: number): string {
  const deadline = Date.now() - PENDING_TTL_MS;
  for (const [key, value] of pending) if (value.at < deadline) pending.delete(key);

  const token = slug(10);
  pending.set(token, { userId, url, playlistId, at: Date.now() });
  return token;
}

/**
 * Запускает загрузку и ведёт её в том же сообщении.
 *
 * Правим один текст, а не сыплем новыми: плейлист на два десятка треков иначе
 * превращает переписку в ленту. Одинаковый текст Telegram отвергает, поэтому
 * сравниваем с показанным.
 */
async function runDownload(ctx: Context, token: string): Promise<void> {
  const request = pending.get(token);

  if (!request || request.userId !== ctx.from?.id) {
    await ctx.answerCallbackQuery('Ссылка устарела — пришли её ещё раз');
    return;
  }

  let job: DownloadJob;
  try {
    job = await startDownload(request.userId, request.url, request.playlistId);
  } catch (error) {
    await ctx.answerCallbackQuery(
      error instanceof AppError ? error.message.slice(0, 190) : 'Не получилось запустить',
    );
    return;
  }

  pending.delete(token);
  await ctx.answerCallbackQuery('Качаю');

  const message = ctx.callbackQuery?.message;
  if (!message) return;

  let shown = '';

  for (;;) {
    const fresh = getJob(request.userId, job.id) ?? job;
    const text = describeDownload(fresh);

    if (text !== shown) {
      shown = text;
      await ctx.api
        .editMessageText(message.chat.id, message.message_id, text, {
          reply_markup: fresh.state === 'running' ? undefined : openApp,
        })
        .catch(() => undefined);
    }

    if (fresh.state !== 'running') return;
    await sleep(4000);
  }
}

function describeDownload(job: DownloadJob): string {
  const downloaded = job.added.filter((item) => item.downloaded).length;

  const lines =
    job.state === 'running'
      ? [`Качаю «${job.name}»: ${job.done} из ${job.total}…`]
      : job.state === 'failed'
        ? [`Загрузка «${job.name}» сорвалась.`, job.error ?? '']
        : [`Готово: «${job.name}».`];

  lines.push('');
  lines.push(`Скачано: ${downloaded}`);
  if (job.added.length > downloaded) {
    lines.push(`Нашлось в каталоге: ${job.added.length - downloaded}`);
  }

  if (job.failed.length > 0) {
    lines.push(`Не вышло: ${job.failed.length}`);
    lines.push(
      ...job.failed
        .slice(0, 10)
        .map((item) => `· ${[item.performer, item.title].filter(Boolean).join(' — ')} — ${item.reason}`),
    );
  }

  return lines.join('\n');
}

async function notify(userId: number, text: string, keyboard = openApp): Promise<void> {
  try {
    await bot.api.sendMessage(userId, text, { reply_markup: keyboard });
  } catch {
    // Пользователь мог не открывать личку с ботом — не страшно.
  }
}
