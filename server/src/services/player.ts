import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { postedMessages } from '../db/schema.js';
import { bot } from '../bot/bot.js';
import { config } from '../config.js';
import { getUser, type Track } from './catalog.js';
import { getPlaylistTracks, type Playlist } from './playlists.js';
import { AppError, messageLink, sleep } from '../utils.js';

/** Не даём одному пользователю запустить две перезаписи канала одновременно. */
const busy = new Set<number>();

export type PlayResult = {
  url: string;
  total: number;
  posted: number;
};

/**
 * Материализует плейлист в канал пользователя.
 *
 * Запустить воспроизведение программно нельзя — такого API у Telegram нет.
 * Поэтому задача сервера: подготовить канал и вернуть ссылку на первый трек.
 * Мини-апп открывает её через openTelegramLink, пользователь делает один тап,
 * дальше нативный плеер идёт по сообщениям подряд сам.
 */
export async function playPlaylist(userId: number, playlist: Playlist): Promise<PlayResult> {
  const user = getUser(userId);
  if (!user?.playbackChatId) {
    throw new AppError(
      'no_playback_channel',
      'Сначала создай канал «Моя музыка» и добавь бота админом',
    );
  }

  const tracks = getPlaylistTracks(playlist.id);
  if (tracks.length === 0) {
    throw new AppError('empty_playlist', 'В плейлисте пока нет треков');
  }

  if (busy.has(userId)) {
    throw new AppError('busy', 'Предыдущий плейлист ещё выкладывается, подожди пару секунд', 409);
  }
  busy.add(userId);

  const chatId = user.playbackChatId;
  try {
    await clearChannel(userId, chatId);

    const head = tracks.slice(0, config.playbackHead);
    let firstMessageId: number | null = null;

    for (const track of head) {
      const messageId = await postTrack(userId, chatId, track);
      firstMessageId ??= messageId;
    }

    if (firstMessageId === null) {
      throw new AppError('post_failed', 'Не получилось выложить треки в канал — проверь права бота');
    }

    // Хвост уходит фоном: ответ отдаём сразу, слушать можно с первого трека.
    const tail = tracks.slice(config.playbackHead);
    if (tail.length > 0) void postTail(userId, chatId, tail);

    return { url: messageLink(chatId, firstMessageId), total: tracks.length, posted: head.length };
  } finally {
    busy.delete(userId);
  }
}

async function postTrack(userId: number, chatId: number, track: Track): Promise<number | null> {
  try {
    const message = await bot.api.sendAudio(chatId, track.fileId, {
      title: track.title ?? undefined,
      performer: track.performer ?? undefined,
      duration: track.duration ?? undefined,
    });
    db.insert(postedMessages).values({ userId, chatId, messageId: message.message_id }).run();
    return message.message_id;
  } catch (error) {
    console.error('[player] не удалось отправить трек', track.id, error);
    return null;
  }
}

async function postTail(userId: number, chatId: number, tail: Track[]): Promise<void> {
  for (const track of tail) {
    await sleep(config.playbackDelayMs);
    await postTrack(userId, chatId, track);
  }
}

/** Чистим то, что бот клал раньше: канал показывает ровно один текущий плейлист. */
async function clearChannel(userId: number, chatId: number): Promise<void> {
  const previous = db.select().from(postedMessages).where(eq(postedMessages.userId, userId)).all();

  for (const row of previous) {
    try {
      await bot.api.deleteMessage(row.chatId, row.messageId);
    } catch {
      // Сообщение могли удалить руками — это нормально.
    }
  }

  db.delete(postedMessages).where(eq(postedMessages.userId, userId)).run();
}
