import { addToLibrary, ingestDownloaded } from './catalog.js';
import { addTrack } from './playlists.js';
import { fetchAudio, fetcherAvailable, type FetchTarget } from './fetcher.js';
import { matchInCatalog, resolveLink, type ImportItem } from './import.js';
import { config } from '../config.js';
import { AppError, now, slug } from '../utils.js';

/**
 * Загрузка треков по ссылке.
 *
 * Идёт фоном: качается и перекодируется один трек за другой, плейлист на два
 * десятка позиций занимает минуты — в HTTP-запрос это не помещается. Клиент
 * получает id задачи и опрашивает её состояние.
 *
 * Задачи живут в памяти. Перезапуск процесса их теряет; в базу класть нечего —
 * незавершённую загрузку всё равно пришлось бы начинать заново, а всё, что
 * успело скачаться, уже лежит в фонотеке.
 */

export type DownloadState = 'running' | 'done' | 'failed';

export type DownloadJob = {
  id: string;
  userId: number;
  state: DownloadState;
  /** Название плейлиста или трека по ссылке — чтобы было видно, что качается. */
  name: string;
  source: string;
  total: number;
  done: number;
  added: Array<{ title: string; performer: string | null; trackId: number; downloaded: boolean }>;
  failed: Array<{ title: string; performer: string | null; reason: string }>;
  error: string | null;
  updatedAt: number;
};

const jobs = new Map<string, DownloadJob>();

/** Одна загрузка на пользователя: иначе один человек занимает весь процессор. */
const busy = new Set<number>();

const KEEP_FINISHED_SECONDS = 30 * 60;

export function getJob(userId: number, id: string): DownloadJob | undefined {
  const job = jobs.get(id);
  return job?.userId === userId ? job : undefined;
}

/**
 * Ставит загрузку в работу и сразу возвращает задачу. Ссылка разбирается уже
 * внутри: цель для yt-dlp формируется только на сервере, из того, что отдала
 * площадка, — клиент не может подсунуть произвольную строку загрузчику.
 */
export async function startDownload(
  userId: number,
  url: string,
  playlistId?: number,
): Promise<DownloadJob> {
  if (!(await fetcherAvailable())) {
    throw new AppError(
      'fetcher_unavailable',
      'Загрузка по ссылке выключена: на сервере нет yt-dlp. Добавь его в образ или задай YTDLP_PATH.',
    );
  }

  if (busy.has(userId)) {
    throw new AppError('busy', 'Предыдущая загрузка ещё идёт — дождись её', 409);
  }

  const resolved = await resolveLink(url);
  const items = resolved.items.slice(0, config.downloadMaxItems);

  const job: DownloadJob = {
    id: slug(12),
    userId,
    state: 'running',
    name: resolved.name,
    source: resolved.source,
    total: items.length,
    done: 0,
    added: [],
    failed: [],
    error: null,
    updatedAt: now(),
  };

  jobs.set(job.id, job);
  busy.add(userId);
  sweep();

  // Намеренно без await: HTTP-ответ уходит сразу, работа продолжается фоном.
  void run(job, items, playlistId).finally(() => busy.delete(userId));

  return job;
}

async function run(job: DownloadJob, items: ImportItem[], playlistId?: number): Promise<void> {
  try {
    for (const item of items) {
      await handle(job, item, playlistId);
      job.done++;
      job.updatedAt = now();
    }

    job.state = 'done';
  } catch (error) {
    job.state = 'failed';
    job.error = error instanceof AppError ? error.message : 'Загрузка сорвалась';
    console.error('[download] задача упала', job.id, error);
  } finally {
    job.updatedAt = now();
  }
}

async function handle(job: DownloadJob, item: ImportItem, playlistId?: number): Promise<void> {
  const label = { title: item.title, performer: item.performer };

  // Скачивать то, что уже лежит в Telegram, незачем: файл общий, добавление
  // в фонотеку — это строка в базе.
  const existing = matchInCatalog(item);
  if (existing) {
    addToLibrary(job.userId, existing.id);
    if (playlistId !== undefined) addTrack(playlistId, existing.id);
    job.added.push({ ...label, trackId: existing.id, downloaded: false });
    return;
  }

  let file;
  try {
    file = await fetchAudio(targetFor(item));
  } catch (error) {
    job.failed.push({ ...label, reason: error instanceof AppError ? error.message : 'не скачалось' });
    return;
  }

  try {
    // Название с площадки точнее, чем заголовок ролика: «Artist - Title (Official Video)»
    // после нормализации всё равно ищется плохо, а в плеере выглядит мусором.
    const { track } = await ingestDownloaded(
      {
        path: file.path,
        title: item.title || file.title,
        performer: item.performer ?? file.performer,
        duration: file.duration,
        sourceKey: file.sourceKey,
      },
      job.userId,
    );

    if (playlistId !== undefined) addTrack(playlistId, track.id);
    job.added.push({ ...label, trackId: track.id, downloaded: true });
  } catch (error) {
    job.failed.push({
      ...label,
      reason: error instanceof AppError ? error.message : 'не удалось залить в Telegram',
    });
    console.error('[download] заливка не удалась', error);
  } finally {
    await file.cleanup();
  }
}

/**
 * Откуда качать. Прямая ссылка есть только у YouTube и SoundCloud; для треков
 * из Deezer, Apple Music и Spotify скачивать неоткуда, поэтому ищем то же самое
 * по названию — первый результат поиска.
 */
function targetFor(item: ImportItem): FetchTarget {
  if (item.target) return { kind: 'url', url: item.target };
  return { kind: 'search', query: [item.performer, item.title].filter(Boolean).join(' ') };
}

/** Завершённые задачи держим полчаса: столько живёт открытая вкладка мини-аппа. */
function sweep(): void {
  const deadline = now() - KEEP_FINISHED_SECONDS;

  for (const [id, job] of jobs) {
    if (job.state !== 'running' && job.updatedAt < deadline) jobs.delete(id);
  }
}
