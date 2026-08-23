import { and, asc, desc, eq, max, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { playlistItems, playlists, tracks } from '../db/schema.js';
import { addToLibrary, type Track } from './catalog.js';
import { AppError, now, slug } from '../utils.js';

export type Playlist = typeof playlists.$inferSelect;

export function listPlaylists(ownerId: number) {
  return db
    .select({
      id: playlists.id,
      title: playlists.title,
      isPublic: playlists.isPublic,
      slug: playlists.slug,
      sourcePlaylistId: playlists.sourcePlaylistId,
      createdAt: playlists.createdAt,
      // Имена таблиц пишем полностью: без квалификатора SQLite резолвит id в playlist_items.id.
      trackCount: sql<number>`(SELECT COUNT(*) FROM playlist_items WHERE playlist_items.playlist_id = playlists.id)`,
    })
    .from(playlists)
    .where(eq(playlists.ownerId, ownerId))
    .orderBy(desc(playlists.createdAt))
    .all();
}

export function createPlaylist(ownerId: number, title: string): Playlist {
  const clean = title.trim().slice(0, 80);
  if (!clean) throw new AppError('empty_title', 'Название не может быть пустым');
  return db
    .insert(playlists)
    .values({ ownerId, title: clean, createdAt: now() })
    .returning()
    .get();
}

/**
 * Плейлист, привязанный к группе-источнику.
 *
 * Историю группы бот прочитать не может — в Bot API нет метода для прошлых
 * сообщений. Поэтому связь работает только вперёд: всё, что появится в группе
 * после подключения, дописывается сюда. Старое переносится пересылкой в личку.
 */
export function createLinkedPlaylist(ownerId: number, title: string, sourceChatId: number): Playlist {
  return db
    .insert(playlists)
    .values({
      ownerId,
      title: title.trim().slice(0, 80) || 'Без названия',
      sourceChatId,
      syncEnabled: 1,
      createdAt: now(),
    })
    .returning()
    .get();
}

export function findBySourceChat(chatId: number): Playlist | undefined {
  return db.select().from(playlists).where(eq(playlists.sourceChatId, chatId)).get();
}

export function setSync(playlist: Playlist, enabled: boolean): Playlist {
  return db
    .update(playlists)
    .set({ syncEnabled: enabled ? 1 : 0 })
    .where(eq(playlists.id, playlist.id))
    .returning()
    .get();
}

export function getPlaylist(id: number): Playlist | undefined {
  return db.select().from(playlists).where(eq(playlists.id, id)).get();
}

export function getPlaylistBySlug(value: string): Playlist | undefined {
  return db.select().from(playlists).where(eq(playlists.slug, value)).get();
}

/** Плейлист владельца, иначе 404 — чтобы не подсматривали чужие id. */
export function requireOwned(id: number, ownerId: number): Playlist {
  const playlist = getPlaylist(id);
  if (!playlist || playlist.ownerId !== ownerId) {
    throw new AppError('not_found', 'Плейлист не найден', 404);
  }
  return playlist;
}

export function getPlaylistTracks(playlistId: number): Track[] {
  return db
    .select({ track: tracks })
    .from(playlistItems)
    .innerJoin(tracks, eq(tracks.id, playlistItems.trackId))
    .where(eq(playlistItems.playlistId, playlistId))
    .orderBy(asc(playlistItems.position))
    .all()
    .map((row) => row.track);
}

export function addTrack(playlistId: number, trackId: number): void {
  const already = db
    .select()
    .from(playlistItems)
    .where(and(eq(playlistItems.playlistId, playlistId), eq(playlistItems.trackId, trackId)))
    .get();
  if (already) return;

  const last = db
    .select({ value: max(playlistItems.position) })
    .from(playlistItems)
    .where(eq(playlistItems.playlistId, playlistId))
    .get();

  db.insert(playlistItems)
    .values({ playlistId, trackId, position: (last?.value ?? 0) + 1 })
    .run();
}

export function removeTrack(playlistId: number, trackId: number): void {
  db.delete(playlistItems)
    .where(and(eq(playlistItems.playlistId, playlistId), eq(playlistItems.trackId, trackId)))
    .run();
}

/** Публикация — это выдача slug для deep link t.me/<bot>/app?startapp=<slug>. */
export function publish(playlist: Playlist): Playlist {
  return db
    .update(playlists)
    .set({ isPublic: 1, slug: playlist.slug ?? slug() })
    .where(eq(playlists.id, playlist.id))
    .returning()
    .get();
}

export function unpublish(playlist: Playlist): Playlist {
  return db
    .update(playlists)
    .set({ isPublic: 0 })
    .where(eq(playlists.id, playlist.id))
    .returning()
    .get();
}

/**
 * «Добавить себе» чужой плейлист. Копируются только строки в БД — файлы общие,
 * поэтому операция стоит примерно ничего независимо от размера плейлиста.
 */
export function clone(source: Playlist, newOwnerId: number): Playlist {
  if (!source.isPublic) throw new AppError('not_public', 'Плейлист не опубликован', 403);

  const copy = db
    .insert(playlists)
    .values({
      ownerId: newOwnerId,
      title: source.title,
      sourcePlaylistId: source.id,
      createdAt: now(),
    })
    .returning()
    .get();

  const items = getPlaylistTracks(source.id);
  items.forEach((track, index) => {
    db.insert(playlistItems)
      .values({ playlistId: copy.id, trackId: track.id, position: index + 1 })
      .run();
    addToLibrary(newOwnerId, track.id);
  });

  return copy;
}

export function renamePlaylist(playlist: Playlist, title: string): Playlist {
  const clean = title.trim().slice(0, 80);
  if (!clean) throw new AppError('empty_title', 'Название не может быть пустым');

  return db
    .update(playlists)
    .set({ title: clean })
    .where(eq(playlists.id, playlist.id))
    .returning()
    .get();
}

/**
 * «Смешать все» — один плейлист из всех треков пользователя, в случайном порядке.
 * Дубли схлопываются: один и тот же трек может лежать в нескольких плейлистах.
 */
export function mergeAll(ownerId: number, title?: string): Playlist {
  const owned = db.select().from(playlists).where(eq(playlists.ownerId, ownerId)).all();

  const seen = new Set<number>();
  const pool: number[] = [];

  for (const source of owned) {
    for (const track of getPlaylistTracks(source.id)) {
      if (seen.has(track.id)) continue;
      seen.add(track.id);
      pool.push(track.id);
    }
  }

  if (pool.length === 0) {
    throw new AppError('nothing_to_merge', 'Пока нечего смешивать — плейлисты пусты');
  }

  shuffle(pool);

  const mixed = createPlaylist(ownerId, title?.trim() || 'Всё вперемешку');
  pool.forEach((trackId, index) => {
    db.insert(playlistItems)
      .values({ playlistId: mixed.id, trackId, position: index + 1 })
      .run();
  });

  return mixed;
}

function shuffle(items: number[]): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

export function deletePlaylist(playlist: Playlist): void {
  db.delete(playlistItems).where(eq(playlistItems.playlistId, playlist.id)).run();
  db.delete(playlists).where(eq(playlists.id, playlist.id)).run();
}
