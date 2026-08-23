import { Hono } from 'hono';
import { auth, type Env } from './auth.js';
import { config } from '../config.js';
import { bot } from '../bot/bot.js';
import {
  getLibrary,
  getTrack,
  getUser,
  isInLibrary,
  searchTracks,
  setPlaybackChat,
} from '../services/catalog.js';
import {
  addTrack,
  clone,
  createPlaylist,
  deletePlaylist,
  getPlaylistBySlug,
  getPlaylistTracks,
  listPlaylists,
  mergeAll,
  publish,
  removeTrack,
  renamePlaylist,
  requireOwned,
  setSync,
  unpublish,
} from '../services/playlists.js';
import { clearPlayerChat, playPlaylist, playTracks } from '../services/player.js';
import { createSession, revokeSessions } from '../services/sessions.js';
import { applyOverride, applyOverrides, setOverride } from '../services/overrides.js';
import { applyVariant, syncVariant } from '../services/variants.js';
import { listPlayableChats, verifyPlayerChat } from '../services/chats.js';
import { importFromLink } from '../services/import.js';
import { getJob, startDownload } from '../services/downloads.js';
import { findLinks } from '../services/links.js';
import { AppError } from '../utils.js';
import type { Track } from '../services/catalog.js';

/**
 * Наружу отдаём только то, что нужно интерфейсу. file_id, номер сообщения
 * в хранилище и автор загрузки — внутренние детали, клиенту они ни к чему.
 */
function publicTrack(track: Track) {
  return {
    id: track.id,
    title: track.title,
    performer: track.performer,
    duration: track.duration,
  };
}

export const api = new Hono<Env>();

api.use('*', auth);

api.onError((error, c) => {
  if (error instanceof AppError) {
    return c.json({ error: error.code, message: error.message }, error.status as 400);
  }
  console.error('[api] ошибка', error);
  return c.json({ error: 'internal' }, 500);
});

api.get('/me', async (c) => {
  const user = getUser(c.get('userId'));

  // Название группы-плеера показываем в настройках, чтобы было видно, что подключено.
  let playerChatTitle: string | null = null;
  if (user?.playbackChatId) {
    try {
      const chat = await bot.api.getChat(user.playbackChatId);
      playerChatTitle = 'title' in chat ? (chat.title ?? null) : null;
    } catch {
      playerChatTitle = null;
    }
  }

  return c.json({
    id: user?.id,
    username: user?.username,
    firstName: user?.firstName,
    hasPlayerChat: Boolean(user?.playbackChatId),
    playerChatTitle,
  });
});

api.post('/session', (c) => {
  const token = createSession(c.get('userId'));
  return c.json({ token, url: `${config.webappUrl.replace(/\/$/, '')}/?s=${token}` });
});

api.delete('/session', (c) => {
  revokeSessions(c.get('userId'));
  return c.json({ ok: true });
});

api.get('/library', (c) => {
  const userId = c.get('userId');
  return c.json({ tracks: applyOverrides(userId, getLibrary(userId)).map(publicTrack) });
});

api.get('/search', (c) => {
  const query = c.req.query('q')?.trim() ?? '';
  const tracks = query.length >= 2 ? searchTracks(query) : [];
  return c.json({ tracks: applyOverrides(c.get('userId'), tracks).map(publicTrack) });
});

// ── Плейлисты ────────────────────────────────────────────────────────────────

api.get('/playlists', (c) => c.json({ playlists: listPlaylists(c.get('userId')) }));

api.post('/playlists', async (c) => {
  const body = await c.req.json<{ title?: string }>();
  return c.json({ playlist: createPlaylist(c.get('userId'), body.title ?? '') }, 201);
});

/** «Смешать все» — новый плейлист из всех треков пользователя в случайном порядке. */
api.post('/playlists/merge', async (c) => {
  const body = await c.req
    .json<{ title?: string }>()
    .catch(() => ({}) as { title?: string });

  return c.json({ playlist: mergeAll(c.get('userId'), body.title) }, 201);
});

api.get('/playlists/:id', (c) => {
  const userId = c.get('userId');
  const playlist = requireOwned(Number(c.req.param('id')), userId);

  return c.json({
    playlist,
    tracks: applyOverrides(userId, getPlaylistTracks(playlist.id)).map(publicTrack),
  });
});

api.patch('/playlists/:id', async (c) => {
  let playlist = requireOwned(Number(c.req.param('id')), c.get('userId'));
  const body = await c.req.json<{ title?: string; syncEnabled?: boolean }>();

  if (body.syncEnabled !== undefined) {
    if (!playlist.sourceChatId) {
      throw new AppError('not_linked', 'Плейлист не связан с группой');
    }
    playlist = setSync(playlist, body.syncEnabled);
  }

  if (body.title !== undefined) {
    playlist = renamePlaylist(playlist, body.title);
  }

  return c.json({ playlist });
});

api.delete('/playlists/:id', (c) => {
  deletePlaylist(requireOwned(Number(c.req.param('id')), c.get('userId')));
  return c.json({ ok: true });
});

api.post('/playlists/:id/tracks', async (c) => {
  const playlist = requireOwned(Number(c.req.param('id')), c.get('userId'));
  const body = await c.req.json<{ trackId?: number }>();

  const track = body.trackId ? getTrack(body.trackId) : undefined;
  if (!track) throw new AppError('track_not_found', 'Трек не найден', 404);

  addTrack(playlist.id, track.id);
  return c.json({ ok: true });
});

api.delete('/playlists/:id/tracks/:trackId', (c) => {
  const playlist = requireOwned(Number(c.req.param('id')), c.get('userId'));
  removeTrack(playlist.id, Number(c.req.param('trackId')));
  return c.json({ ok: true });
});

// ── Воспроизведение ──────────────────────────────────────────────────────────

/** Выкладывает плейлист в группу-плеер и отдаёт ссылку на первый трек. */
api.post('/playlists/:id/play', async (c) => {
  const playlist = requireOwned(Number(c.req.param('id')), c.get('userId'));
  const body = await c.req
    .json<{ fromTrackId?: number }>()
    .catch(() => ({}) as { fromTrackId?: number });

  return c.json(await playPlaylist(c.get('userId'), playlist, body.fromTrackId));
});

api.post('/tracks/:id/play', async (c) => {
  const userId = c.get('userId');
  const track = getTrack(Number(c.req.param('id')));

  if (!track || !isInLibrary(userId, track.id)) {
    throw new AppError('track_not_found', 'Трек не найден', 404);
  }

  return c.json(await playTracks(userId, [track]));
});

/** Убрать всё, что бот выложил, — чтобы плеер не подхватил остатки. */
api.post('/player/clear', async (c) => {
  return c.json({ deleted: await clearPlayerChat(c.get('userId')) });
});

// ── Треки ────────────────────────────────────────────────────────────────────

/** Переименование живёт на пользователе: каталог общий и правку соседу не показываем. */
api.patch('/tracks/:id', async (c) => {
  const userId = c.get('userId');
  const trackId = Number(c.req.param('id'));
  const track = getTrack(trackId);

  if (!track || !isInLibrary(userId, trackId)) {
    throw new AppError('track_not_found', 'Трек не найден', 404);
  }

  const body = await c.req.json<{ title?: string | null; performer?: string | null }>();
  setOverride(userId, trackId, body);

  const named = applyOverride(userId, track);

  // Telegram берёт название из атрибутов файла и переданные теги при отправке
  // по file_id игнорирует. Чтобы правка была видна в плеере, а не только здесь,
  // заливаем личную копию с нужными тегами.
  const variant = await syncVariant(userId, track, {
    title: named.title ?? null,
    performer: named.performer ?? null,
  });

  return c.json({ track: publicTrack(named), variant });
});

/** Прислать файл трека в личку. */
api.post('/tracks/:id/send', async (c) => {
  const userId = c.get('userId');
  const track = getTrack(Number(c.req.param('id')));

  if (!track || !isInLibrary(userId, track.id)) {
    throw new AppError('track_not_found', 'Трек не найден', 404);
  }

  const named = applyVariant(userId, applyOverride(userId, track));
  await bot.api.sendAudio(userId, named.fileId, {
    title: named.title ?? undefined,
    performer: named.performer ?? undefined,
    duration: named.duration ?? undefined,
  });

  return c.json({ ok: true });
});

/** Где этот трек лежит на других площадках — Apple Music и Deezer точно, остальные поиском. */
api.get('/tracks/:id/links', async (c) => {
  const userId = c.get('userId');
  const track = getTrack(Number(c.req.param('id')));

  if (!track || !isInLibrary(userId, track.id)) {
    throw new AppError('track_not_found', 'Трек не найден', 404);
  }

  return c.json({ links: await findLinks(applyOverride(userId, track)) });
});

// ── Плеер ────────────────────────────────────────────────────────────────────

/** Группы, куда пользователь добавлял бота, — из них и выбирается плеер. */
api.get('/chats', async (c) => c.json({ chats: await listPlayableChats(c.get('userId')) }));

/** Назначить группу плеером. Права проверяются заново: статус мог измениться. */
api.post('/player', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ chatId?: number }>();

  if (typeof body.chatId !== 'number') {
    throw new AppError('chat_required', 'Не указана группа');
  }

  const chat = await verifyPlayerChat(userId, body.chatId);

  // Прошлый плеер чистим до переключения: иначе выложенное там останется навсегда,
  // а ссылки на удаление мы потеряем вместе со сменой чата.
  const previous = getUser(userId)?.playbackChatId;
  if (previous && previous !== chat.id) await clearPlayerChat(userId);

  setPlaybackChat(userId, chat.id);
  return c.json({ chat });
});

api.delete('/player', async (c) => {
  const userId = c.get('userId');
  await clearPlayerChat(userId);
  setPlaybackChat(userId, null);
  return c.json({ ok: true });
});

// ── Импорт по ссылке ─────────────────────────────────────────────────────────

/**
 * Ссылка с другой площадки. Аудио оттуда взять нельзя — берём список названий
 * и подбираем совпадения в общем каталоге, ненайденное возвращаем как есть.
 */
api.post('/import', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ url?: string; playlistId?: number }>();

  if (!body.url?.trim()) throw new AppError('url_required', 'Пришли ссылку');

  const playlistId =
    body.playlistId === undefined ? undefined : requireOwned(body.playlistId, userId).id;

  return c.json(await importFromLink(userId, body.url, playlistId));
});

/**
 * Скачать то, чего нет в каталоге. Ссылка разбирается заново на сервере: цель
 * для загрузчика нельзя принимать от клиента — иначе поле ввода превращается
 * в произвольную команду yt-dlp.
 */
api.post('/import/download', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ url?: string; playlistId?: number }>();

  if (!body.url?.trim()) throw new AppError('url_required', 'Пришли ссылку');

  const playlistId =
    body.playlistId === undefined ? undefined : requireOwned(body.playlistId, userId).id;

  return c.json({ job: await startDownload(userId, body.url, playlistId) }, 202);
});

api.get('/import/jobs/:id', (c) => {
  const job = getJob(c.get('userId'), c.req.param('id'));
  if (!job) throw new AppError('job_not_found', 'Загрузка не найдена', 404);

  return c.json({ job });
});

// ── Публикация и шаринг ──────────────────────────────────────────────────────

api.post('/playlists/:id/publish', (c) => {
  const playlist = requireOwned(Number(c.req.param('id')), c.get('userId'));
  const published = publish(playlist);

  return c.json({
    playlist: published,
    shareUrl: `${config.webappUrl.replace(/\/$/, '')}?startapp=${published.slug}`,
  });
});

api.post('/playlists/:id/unpublish', (c) => {
  const playlist = requireOwned(Number(c.req.param('id')), c.get('userId'));
  return c.json({ playlist: unpublish(playlist) });
});

api.get('/shared/:slug', (c) => {
  const playlist = getPlaylistBySlug(c.req.param('slug'));
  if (!playlist?.isPublic) throw new AppError('not_found', 'Плейлист не найден', 404);

  const owner = getUser(playlist.ownerId);
  return c.json({
    playlist: { id: playlist.id, title: playlist.title, slug: playlist.slug },
    owner: { username: owner?.username, firstName: owner?.firstName },
    tracks: getPlaylistTracks(playlist.id).map(publicTrack),
    isMine: playlist.ownerId === c.get('userId'),
  });
});

api.post('/shared/:slug/add', (c) => {
  const playlist = getPlaylistBySlug(c.req.param('slug'));
  if (!playlist?.isPublic) throw new AppError('not_found', 'Плейлист не найден', 404);

  return c.json({ playlist: clone(playlist, c.get('userId')) }, 201);
});
