import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';
import { createPlaylist, getPlaylistTracks } from './playlists.js';

/**
 * Сбор плейлиста прямо в переписке с ботом:
 *   /new → бот спрашивает название → пользователь сыплет треки → /done
 *
 * Состояние живёт в БД, а не в памяти: деплой на Railway перезапускает процесс,
 * и незавершённый сбор иначе терялся бы посреди диалога.
 */
export type DraftStage = 'awaiting_title' | 'collecting';

export function startDraft(userId: number): void {
  db.update(users)
    .set({ draftStage: 'awaiting_title', draftPlaylistId: null })
    .where(eq(users.id, userId))
    .run();
}

export function nameDraft(userId: number, title: string): number {
  const playlist = createPlaylist(userId, title);

  db.update(users)
    .set({ draftStage: 'collecting', draftPlaylistId: playlist.id })
    .where(eq(users.id, userId))
    .run();

  return playlist.id;
}

/** Досбор в уже существующий плейлист — так переносится история группы пересылкой. */
export function attachDraft(userId: number, playlistId: number): void {
  db.update(users)
    .set({ draftStage: 'collecting', draftPlaylistId: playlistId })
    .where(eq(users.id, userId))
    .run();
}

export function getDraft(userId: number): { stage: DraftStage; playlistId: number | null } | null {
  const user = db.select().from(users).where(eq(users.id, userId)).get();
  if (!user?.draftStage) return null;

  return { stage: user.draftStage, playlistId: user.draftPlaylistId };
}

/** Возвращает id и количество набранных треков, либо null если сбора не было. */
export function finishDraft(userId: number): { playlistId: number; count: number } | null {
  const draft = getDraft(userId);
  clearDraft(userId);

  if (!draft?.playlistId) return null;

  return { playlistId: draft.playlistId, count: getPlaylistTracks(draft.playlistId).length };
}

export function clearDraft(userId: number): void {
  db.update(users).set({ draftStage: null, draftPlaylistId: null }).where(eq(users.id, userId)).run();
}
