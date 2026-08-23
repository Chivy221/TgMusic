import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { postedMessages } from '../db/schema.js';
import { bot } from '../bot/bot.js';
import { config } from '../config.js';
import { getUser, type Track } from './catalog.js';
import { getPlaylistTracks, type Playlist } from './playlists.js';
import { applyOverrides } from './overrides.js';
import { applyVariants } from './variants.js';
import { AppError, messageLink, sleep } from '../utils.js';

/** Не даём одному пользователю запустить две перезаписи группы одновременно. */
const busy = new Set<number>();

export type PlayResult = {
  url: string;
  total: number;
  posted: number;
};

/**
 * Выкладывает плейлист в группу-плеер.
 *
 * Событий воспроизведения Telegram не отдаёт — узнать, что трек дослушан, нельзя
 * ничем. Поэтому подсыпать по мере прослушивания невозможно: кладём весь плейлист
 * целиком, а нативный плеер идёт по сообщениям подряд сам.
 */
export async function playTracks(userId: number, queue: Track[]): Promise<PlayResult> {
  const user = getUser(userId);
  if (!user?.playbackChatId) {
    throw new AppError(
      'no_player_chat',
      'Сначала подключи группу-плеер: создай группу, добавь бота и выдай ему права администратора',
    );
  }

  if (queue.length === 0) {
    throw new AppError('nothing_to_play', 'Нечего проигрывать');
  }

  if (busy.has(userId)) {
    throw new AppError('busy', 'Предыдущий плейлист ещё выкладывается, подожди', 409);
  }
  busy.add(userId);

  // Названия показываем такими, какими их видит владелец, с его правками. Там, где
  // под правку залита личная копия файла, играет она: иначе Telegram покажет
  // старые теги, зашитые в исходный файл.
  const tracks = applyVariants(userId, applyOverrides(userId, queue));
  const chatId = user.playbackChatId;

  try {
    // Старое убираем до выкладки: иначе плеер доиграет до остатков прошлого плейлиста.
    await clearPlayerChat(userId);

    const head = tracks.slice(0, config.playbackHead);
    let firstMessageId: number | null = null;

    for (const track of head) {
      const messageId = await postTrack(userId, chatId, track);
      firstMessageId ??= messageId;
    }

    if (firstMessageId === null) {
      throw new AppError(
        'post_failed',
        'Не получилось выложить треки — проверь, что бот в группе и он администратор',
      );
    }

    const tail = tracks.slice(config.playbackHead);
    if (tail.length > 0) void postTail(userId, chatId, tail);

    return { url: messageLink(chatId, firstMessageId), total: tracks.length, posted: head.length };
  } finally {
    busy.delete(userId);
  }
}

export async function playPlaylist(
  userId: number,
  playlist: Playlist,
  fromTrackId?: number,
): Promise<PlayResult> {
  const all = getPlaylistTracks(playlist.id);
  if (all.length === 0) {
    throw new AppError('empty_playlist', 'В плейлисте пока нет треков');
  }

  if (fromTrackId === undefined) return playTracks(userId, all);

  const start = all.findIndex((track) => track.id === fromTrackId);
  if (start === -1) {
    throw new AppError('track_not_in_playlist', 'Этого трека нет в плейлисте', 404);
  }

  return playTracks(userId, all.slice(start));
}

async function postTrack(userId: number, chatId: number, track: Track): Promise<number | null> {
  try {
    const message = await withFloodRetry(() =>
      bot.api.sendAudio(chatId, track.fileId, {
        title: track.title ?? undefined,
        performer: track.performer ?? undefined,
        duration: track.duration ?? undefined,
        disable_notification: true,
      }),
    );

    db.insert(postedMessages).values({ userId, chatId, messageId: message.message_id }).run();
    return message.message_id;
  } catch (error) {
    console.error('[player] не удалось отправить трек', track.id, error);
    return null;
  }
}

/**
 * Хвост уходит фоном с паузой: в одну группу бот может слать примерно
 * двадцать сообщений в минуту, дальше Telegram отвечает 429.
 */
async function postTail(userId: number, chatId: number, tail: Track[]): Promise<void> {
  for (const track of tail) {
    await sleep(config.playbackDelayMs);
    await postTrack(userId, chatId, track);
  }
}

/** При 429 Telegram сам говорит, сколько ждать — уважаем и повторяем. */
async function withFloodRetry<T>(action: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await action();
    } catch (error) {
      const retryAfter = (error as { parameters?: { retry_after?: number } })?.parameters
        ?.retry_after;

      if (retryAfter === undefined || attempt >= attempts) throw error;

      console.warn(`[player] 429, ждём ${retryAfter}с`);
      await sleep((retryAfter + 1) * 1000);
    }
  }
}

/** Чистим всё, что бот клал раньше: в группе лежит ровно один текущий плейлист. */
export async function clearPlayerChat(userId: number): Promise<number> {
  const previous = db.select().from(postedMessages).where(eq(postedMessages.userId, userId)).all();
  let deleted = 0;

  for (const row of previous) {
    try {
      await bot.api.deleteMessage(row.chatId, row.messageId);
      deleted++;
    } catch {
      // Сообщение могли удалить руками, или ему больше 48 часов и бот не админ.
    }
  }

  db.delete(postedMessages).where(eq(postedMessages.userId, userId)).run();
  return deleted;
}
