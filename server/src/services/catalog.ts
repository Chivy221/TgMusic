import { and, desc, eq, like, or } from 'drizzle-orm';
import { InputFile } from 'grammy';
import { db } from '../db/index.js';
import { library, tracks, users } from '../db/schema.js';
import { bot } from '../bot/bot.js';
import { config } from '../config.js';
import { AppError, now } from '../utils.js';

export type IncomingAudio = {
  fileId: string;
  fileUniqueId: string;
  title?: string;
  performer?: string;
  duration?: number;
  fileSize?: number;
};

export type Track = typeof tracks.$inferSelect;

export function ensureUser(id: number, username?: string, firstName?: string): void {
  db.insert(users)
    .values({ id, username: username ?? null, firstName: firstName ?? null, createdAt: now() })
    .onConflictDoUpdate({
      target: users.id,
      set: { username: username ?? null, firstName: firstName ?? null },
    })
    .run();
}

export function getUser(id: number) {
  return db.select().from(users).where(eq(users.id, id)).get();
}

export function setPlaybackChat(userId: number, chatId: number | null): void {
  db.update(users).set({ playbackChatId: chatId }).where(eq(users.id, userId)).run();
}

/**
 * Кладёт трек в канал-хранилище и в фонотеку пользователя.
 *
 * Дедуп по file_unique_id — он одинаков для одного файла у всех ботов, поэтому один
 * и тот же трек, залитый тысячей людей, хранится один раз. Отправка идёт по file_id,
 * то есть Telegram копирует файл у себя на серверах: мы не качаем и не заливаем байты.
 */
export async function ingestAudio(
  audio: IncomingAudio,
  userId: number,
): Promise<{ track: Track; isNew: boolean }> {
  const existing = db.select().from(tracks).where(eq(tracks.fileUniqueId, audio.fileUniqueId)).get();
  if (existing) {
    addToLibrary(userId, existing.id);
    return { track: existing, isNew: false };
  }

  const message = await bot.api.sendAudio(config.storageChannelId, audio.fileId, {
    title: audio.title,
    performer: audio.performer,
    duration: audio.duration,
  });

  const track = db
    .insert(tracks)
    .values({
      fileUniqueId: audio.fileUniqueId,
      fileId: message.audio?.file_id ?? audio.fileId,
      storageMessageId: message.message_id,
      title: audio.title ?? null,
      performer: audio.performer ?? null,
      duration: audio.duration ?? null,
      fileSize: audio.fileSize ?? null,
      addedBy: userId,
      createdAt: now(),
    })
    .returning()
    .get();

  addToLibrary(userId, track.id);
  return { track, isNew: true };
}

export function addToLibrary(userId: number, trackId: number): void {
  db.insert(library)
    .values({ userId, trackId, addedAt: now() })
    .onConflictDoNothing()
    .run();
}

export function getLibrary(userId: number, limit = 500): Track[] {
  return db
    .select({ track: tracks })
    .from(library)
    .innerJoin(tracks, eq(tracks.id, library.trackId))
    .where(eq(library.userId, userId))
    .orderBy(desc(library.addedAt))
    .limit(limit)
    .all()
    .map((row) => row.track);
}

/** Поиск по общему каталогу — он же источник для inline-режима. */
export function searchTracks(query: string, limit = 50): Track[] {
  const pattern = `%${query}%`;
  return db
    .select()
    .from(tracks)
    .where(or(like(tracks.title, pattern), like(tracks.performer, pattern)))
    .orderBy(desc(tracks.createdAt))
    .limit(limit)
    .all();
}

export function getTrack(id: number): Track | undefined {
  return db.select().from(tracks).where(eq(tracks.id, id)).get();
}

export function isInLibrary(userId: number, trackId: number): boolean {
  return (
    db
      .select()
      .from(library)
      .where(and(eq(library.userId, userId), eq(library.trackId, trackId)))
      .get() !== undefined
  );
}

/**
 * Кладёт в каталог трек, скачанный по ссылке.
 *
 * Отличие от ingestAudio одно, но существенное: файла в Telegram ещё нет,
 * поэтому байты заливаются с диска. Дедуп по file_unique_id тут бесполезен —
 * две загрузки одного ролика дают разные файлы, — так что одинаковость
 * определяем по источнику: youtube:<id> у всех совпадёт.
 */
export async function ingestDownloaded(
  file: { path: string; title: string | null; performer: string | null; duration: number | null; sourceKey: string },
  userId: number,
): Promise<{ track: Track; isNew: boolean }> {
  const existing = getTrackBySource(file.sourceKey);
  if (existing) {
    addToLibrary(userId, existing.id);
    return { track: existing, isNew: false };
  }

  const name = [file.performer, file.title].filter(Boolean).join(' - ') || 'track';
  const message = await bot.api.sendAudio(
    config.storageChannelId,
    new InputFile(file.path, `${name.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 60)}.mp3`),
    {
      title: file.title ?? undefined,
      performer: file.performer ?? undefined,
      duration: file.duration ?? undefined,
      disable_notification: true,
    },
  );

  if (!message.audio) throw new AppError('not_audio', 'Telegram не признал скачанный файл аудио');

  const track = db
    .insert(tracks)
    .values({
      fileUniqueId: message.audio.file_unique_id,
      fileId: message.audio.file_id,
      storageMessageId: message.message_id,
      title: file.title,
      performer: file.performer,
      duration: file.duration ?? message.audio.duration ?? null,
      fileSize: message.audio.file_size ?? null,
      sourceKey: file.sourceKey,
      addedBy: userId,
      createdAt: now(),
    })
    .returning()
    .get();

  addToLibrary(userId, track.id);
  return { track, isNew: true };
}

export function getTrackBySource(sourceKey: string): Track | undefined {
  return db.select().from(tracks).where(eq(tracks.sourceKey, sourceKey)).get();
}
