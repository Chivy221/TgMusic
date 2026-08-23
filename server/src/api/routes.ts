import { Hono } from 'hono';
import { auth, type Env } from './auth.js';
import { config } from '../config.js';
import { getLibrary, getTrack, getUser, searchTracks } from '../services/catalog.js';
import {
  addTrack,
  clone,
  createPlaylist,
  deletePlaylist,
  getPlaylistBySlug,
  getPlaylistTracks,
  listPlaylists,
  publish,
  removeTrack,
  requireOwned,
  unpublish,
} from '../services/playlists.js';
import { playPlaylist } from '../services/player.js';
import { AppError } from '../utils.js';

export const api = new Hono<Env>();

api.use('*', auth);

api.onError((error, c) => {
  if (error instanceof AppError) {
    return c.json({ error: error.code, message: error.message }, error.status as 400);
  }
  console.error('[api] ошибка', error);
  return c.json({ error: 'internal' }, 500);
});

api.get('/me', (c) => {
  const user = getUser(c.get('userId'));
  return c.json({
    id: user?.id,
    username: user?.username,
    firstName: user?.firstName,
    hasPlaybackChannel: Boolean(user?.playbackChatId),
  });
});

api.get('/library', (c) => c.json({ tracks: getLibrary(c.get('userId')) }));

api.get('/search', (c) => {
  const query = c.req.query('q')?.trim() ?? '';
  return c.json({ tracks: query.length >= 2 ? searchTracks(query) : [] });
});

api.get('/playlists', (c) => c.json({ playlists: listPlaylists(c.get('userId')) }));

api.post('/playlists', async (c) => {
  const body = await c.req.json<{ title?: string }>();
  const playlist = createPlaylist(c.get('userId'), body.title ?? '');
  return c.json({ playlist }, 201);
});

api.get('/playlists/:id', (c) => {
  const playlist = requireOwned(Number(c.req.param('id')), c.get('userId'));
  return c.json({ playlist, tracks: getPlaylistTracks(playlist.id) });
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

/** Готовит канал и отдаёт ссылку на первый трек — дальше мини-апп зовёт openTelegramLink. */
api.post('/playlists/:id/play', async (c) => {
  const playlist = requireOwned(Number(c.req.param('id')), c.get('userId'));
  return c.json(await playPlaylist(c.get('userId'), playlist));
});

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

/** Просмотр чужого опубликованного плейлиста — сюда приводит startapp. */
api.get('/shared/:slug', (c) => {
  const playlist = getPlaylistBySlug(c.req.param('slug'));
  if (!playlist?.isPublic) throw new AppError('not_found', 'Плейлист не найден', 404);

  const owner = getUser(playlist.ownerId);
  return c.json({
    playlist: { id: playlist.id, title: playlist.title, slug: playlist.slug },
    owner: { username: owner?.username, firstName: owner?.firstName },
    tracks: getPlaylistTracks(playlist.id),
    isMine: playlist.ownerId === c.get('userId'),
  });
});

api.post('/shared/:slug/add', (c) => {
  const playlist = getPlaylistBySlug(c.req.param('slug'));
  if (!playlist?.isPublic) throw new AppError('not_found', 'Плейлист не найден', 404);
  return c.json({ playlist: clone(playlist, c.get('userId')) }, 201);
});
