import { and, eq, inArray } from 'drizzle-orm';
import { InputFile } from 'grammy';
import { db } from '../db/index.js';
import { trackVariants } from '../db/schema.js';
import { bot } from '../bot/bot.js';
import { config } from '../config.js';
import { now } from '../utils.js';
import type { Track } from './catalog.js';

/**
 * Личная копия трека с исправленными тегами.
 *
 * Telegram хранит название и исполнителя в атрибутах самого файла. При отправке
 * по file_id он берёт их оттуда, а переданные title и performer молча игнорирует —
 * поэтому переименованный трек приходил со старым именем. Единственный способ
 * поменять то, что видно в плеере, — залить файл заново.
 *
 * Заливаем один раз, в момент переименования, и только для того, кто переименовал:
 * канонический трек общий и чужие фонотеки правка не трогает.
 */

/** Скачивать файлы бот может только до 20 МБ — это ограничение Bot API. */
const DOWNLOAD_LIMIT = 20 * 1024 * 1024;

export type Variant = typeof trackVariants.$inferSelect;

export type VariantStatus = 'applied' | 'reverted' | 'unchanged' | 'too_big' | 'failed';

export function getVariant(userId: number, trackId: number): Variant | undefined {
  return db
    .select()
    .from(trackVariants)
    .where(and(eq(trackVariants.userId, userId), eq(trackVariants.trackId, trackId)))
    .get();
}

/**
 * Подменяет file_id на личную копию там, где она есть.
 * Вызывается перед любой отправкой: и в плеер, и в личку, и в inline.
 */
export function applyVariants(userId: number, tracks: Track[]): Track[] {
  if (tracks.length === 0) return tracks;

  const rows = db
    .select()
    .from(trackVariants)
    .where(
      and(
        eq(trackVariants.userId, userId),
        inArray(
          trackVariants.trackId,
          tracks.map((track) => track.id),
        ),
      ),
    )
    .all();

  if (rows.length === 0) return tracks;

  const byTrack = new Map(rows.map((row) => [row.trackId, row]));
  return tracks.map((track) => {
    const variant = byTrack.get(track.id);
    return variant ? { ...track, fileId: variant.fileId } : track;
  });
}

export function applyVariant(userId: number, track: Track): Track {
  return applyVariants(userId, [track])[0];
}

/**
 * Приводит личную копию в соответствие с текущим названием.
 * Если правка отменена и имя снова каноническое — копия удаляется, играет оригинал.
 */
export async function syncVariant(
  userId: number,
  track: Track,
  desired: { title: string | null; performer: string | null },
): Promise<VariantStatus> {
  const existing = getVariant(userId, track.id);
  const canonical =
    (desired.title ?? null) === (track.title ?? null) &&
    (desired.performer ?? null) === (track.performer ?? null);

  if (canonical) {
    if (!existing) return 'unchanged';
    await dropVariant(userId, track.id);
    return 'reverted';
  }

  if (
    existing &&
    (existing.title ?? null) === desired.title &&
    (existing.performer ?? null) === desired.performer
  ) {
    return 'unchanged';
  }

  if (track.fileSize !== null && track.fileSize > DOWNLOAD_LIMIT) return 'too_big';

  try {
    const uploaded = await reupload(track, desired);

    // Старую копию убираем из хранилища, иначе канал растёт с каждой правкой.
    if (existing) await deleteFromStorage(existing.storageMessageId);

    db.insert(trackVariants)
      .values({
        userId,
        trackId: track.id,
        fileId: uploaded.fileId,
        fileUniqueId: uploaded.fileUniqueId,
        storageMessageId: uploaded.messageId,
        title: desired.title,
        performer: desired.performer,
        createdAt: now(),
      })
      .onConflictDoUpdate({
        target: [trackVariants.userId, trackVariants.trackId],
        set: {
          fileId: uploaded.fileId,
          fileUniqueId: uploaded.fileUniqueId,
          storageMessageId: uploaded.messageId,
          title: desired.title,
          performer: desired.performer,
          createdAt: now(),
        },
      })
      .run();

    return 'applied';
  } catch (error) {
    // 20 МБ Telegram считает по своим данным, а file_size у трека может отсутствовать.
    if (String(error).includes('file is too big')) return 'too_big';
    console.error('[variants] не удалось перезалить трек', track.id, error);
    return 'failed';
  }
}

export async function dropVariant(userId: number, trackId: number): Promise<void> {
  const existing = getVariant(userId, trackId);
  if (!existing) return;

  await deleteFromStorage(existing.storageMessageId);
  db.delete(trackVariants)
    .where(and(eq(trackVariants.userId, userId), eq(trackVariants.trackId, trackId)))
    .run();
}

/** Скачиваем байты из Telegram и отдаём обратно уже с нужными тегами. */
async function reupload(
  track: Track,
  desired: { title: string | null; performer: string | null },
): Promise<{ fileId: string; fileUniqueId: string; messageId: number }> {
  const file = await bot.api.getFile(track.fileId);
  if (!file.file_path) throw new Error('Telegram не отдал путь к файлу');

  const response = await fetch(
    `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`,
  );
  if (!response.ok) throw new Error(`Скачивание не удалось: ${response.status}`);

  const bytes = Buffer.from(await response.arrayBuffer());
  const extension = file.file_path.split('.').pop() ?? 'mp3';
  const name = [desired.performer, desired.title].filter(Boolean).join(' - ') || 'track';

  const message = await bot.api.sendAudio(
    config.storageChannelId,
    new InputFile(bytes, `${safeName(name)}.${extension}`),
    {
      title: desired.title ?? undefined,
      performer: desired.performer ?? undefined,
      duration: track.duration ?? undefined,
      disable_notification: true,
    },
  );

  if (!message.audio) throw new Error('Telegram не признал файл аудио');

  return {
    fileId: message.audio.file_id,
    fileUniqueId: message.audio.file_unique_id,
    messageId: message.message_id,
  };
}

async function deleteFromStorage(messageId: number): Promise<void> {
  try {
    await bot.api.deleteMessage(config.storageChannelId, messageId);
  } catch {
    // Сообщение могли удалить руками — не повод ронять переименование.
  }
}

function safeName(value: string): string {
  return value.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 60);
}
