import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import { AppError } from '../utils.js';

/**
 * Загрузка аудио с площадок через yt-dlp.
 *
 * Файлы здесь впервые идут через наш сервер: скачать, перекодировать, залить
 * в Telegram. Отсюда лимиты на размер, длительность и время — иначе один
 * двухчасовой микс займёт диск и процесс на всё это время.
 *
 * Цель для yt-dlp формируется только здесь: строка от пользователя попадает
 * туда исключительно как http(s)-ссылка и всегда после `--`. Иначе `ytsearch:`,
 * `file:` и прочие схемы yt-dlp превратили бы поле ввода в чтение чего угодно.
 */

export type FetchTarget = { kind: 'url'; url: string } | { kind: 'search'; query: string };

export type FetchedAudio = {
  path: string;
  title: string | null;
  performer: string | null;
  duration: number | null;
  /** `youtube:dQw4w9WgXcQ` — чтобы второй раз то же самое не качать. */
  sourceKey: string;
  sourceUrl: string;
  cleanup(): Promise<void>;
};

export type PlaylistEntry = { title: string; performer: string | null; url: string };

type Info = {
  id?: string;
  title?: string;
  track?: string;
  artist?: string;
  creator?: string;
  uploader?: string;
  duration?: number;
  webpage_url?: string;
  url?: string;
  extractor_key?: string;
  extractor?: string;
  entries?: Info[];
};

let available: boolean | null = null;

/** Проверяем один раз за жизнь процесса: в контейнере набор бинарников не меняется. */
export async function fetcherAvailable(): Promise<boolean> {
  if (available !== null) return available;

  try {
    await run([config.ytdlpPath, '--version'], 10_000);
    available = true;
  } catch {
    available = false;
  }

  return available;
}

export function requireFetcher(): void {
  if (available === false) {
    throw new AppError(
      'fetcher_unavailable',
      'Загрузка по ссылке выключена: на сервере нет yt-dlp. Добавь его в образ или задай YTDLP_PATH.',
    );
  }
}

/**
 * Скачивает один трек. Возвращает путь к файлу и метаданные — вызывающий обязан
 * позвать cleanup(), иначе временный каталог останется на диске.
 */
export async function fetchAudio(target: FetchTarget): Promise<FetchedAudio> {
  if (!(await fetcherAvailable())) requireFetcher();

  const dir = await mkdtemp(join(tmpdir(), 'telemusic-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });

  try {
    const { stdout } = await run(
      [
        config.ytdlpPath,
        ...COMMON_ARGS,
        '--no-playlist',
        '-f',
        'bestaudio/best',
        '-x',
        '--audio-format',
        'mp3',
        '--audio-quality',
        '0',
        '--embed-metadata',
        '--max-filesize',
        `${config.downloadMaxMb}M`,
        // `?` после оператора пропускает сравнение, если длительность неизвестна.
        '--match-filter',
        `duration<?${config.downloadMaxSeconds}`,
        '--retries',
        '3',
        '--socket-timeout',
        '20',
        '-o',
        join(dir, 'audio.%(ext)s'),
        '--print-json',
        '--no-simulate',
        '--',
        toArgument(target),
      ],
      config.downloadTimeoutMs,
    );

    const info = lastJson(stdout);
    if (!info?.id) {
      throw new AppError('nothing_found', 'По этой ссылке ничего не нашлось');
    }

    const path = await onlyFile(dir);
    if (!path) {
      throw new AppError(
        'too_big',
        `Файл не скачан: он длиннее ${Math.round(config.downloadMaxSeconds / 60)} минут или тяжелее ${config.downloadMaxMb} МБ`,
      );
    }

    const size = (await stat(path)).size;
    if (size > config.uploadMaxMb * 1024 * 1024) {
      throw new AppError('too_big', `Файл ${Math.round(size / 1024 / 1024)} МБ — Telegram не пропустит`);
    }

    return {
      path,
      ...names(info),
      duration: info.duration ? Math.round(info.duration) : null,
      sourceKey: sourceKey(info),
      sourceUrl: info.webpage_url ?? info.url ?? '',
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/**
 * Список треков плейлиста без скачивания.
 *
 * Нужен для YouTube и SoundCloud: своих API у них нет, а oEmbed отдаёт одно
 * название на весь плейлист. yt-dlp разбирает страницу и возвращает состав.
 */
export async function listPlaylist(url: string): Promise<PlaylistEntry[]> {
  if (!(await fetcherAvailable())) requireFetcher();

  const { stdout } = await run(
    [
      config.ytdlpPath,
      ...COMMON_ARGS,
      '--flat-playlist',
      '--dump-single-json',
      '--playlist-end',
      String(config.downloadMaxItems),
      '--',
      url,
    ],
    config.downloadTimeoutMs,
  );

  const info = lastJson(stdout);
  return (info?.entries ?? [])
    .filter((entry) => entry.url || entry.id)
    .map((entry) => {
      const { title, performer } = names(entry);
      return {
        title: title ?? 'Без названия',
        performer,
        url: entry.url ?? `https://www.youtube.com/watch?v=${entry.id}`,
      };
    });
}

/**
 * Названия. У YouTube Music и SoundCloud бывают отдельные поля track/artist —
 * они точнее, чем «Artist - Title (Official Video)» из заголовка страницы.
 */
function names(info: Info): { title: string | null; performer: string | null } {
  if (info.track) {
    return { title: info.track, performer: info.artist ?? info.uploader ?? null };
  }

  const raw = info.title?.trim() ?? '';
  const uploader = (info.artist ?? info.creator ?? info.uploader ?? '')
    .replace(/\s*-\s*Topic$/, '')
    .trim();

  // YouTube обычно даёт «Artist - Title», SoundCloud — «Title by Artist».
  const dashed = raw.split(/\s[-–—]\s/);
  if (dashed.length >= 2) {
    return { title: dashed.slice(1).join(' - ').trim(), performer: dashed[0].trim() };
  }

  const by = raw.match(/^(.+?)\s+by\s+(.+)$/i);
  if (by) return { title: by[1].trim(), performer: by[2].trim() };

  return { title: raw || null, performer: uploader || null };
}

function sourceKey(info: Info): string {
  const site = (info.extractor_key ?? info.extractor ?? 'unknown').toLowerCase();
  return `${site}:${info.id}`;
}

function toArgument(target: FetchTarget): string {
  if (target.kind === 'search') {
    // Двоеточия и переводы строк в запросе сломали бы разбор цели самим yt-dlp.
    return `ytsearch1:${target.query.replace(/[\r\n:]+/g, ' ').trim()}`;
  }

  const url = new URL(target.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError('bad_url', 'Скачивать умею только по http и https');
  }

  return url.href;
}

/** Общее для всех вызовов: не читать конфиги пользователя и не сорить в stdout. */
const COMMON_ARGS = ['--ignore-config', '--no-warnings', '--no-progress', '--no-colors'];

/**
 * yt-dlp печатает JSON одной строкой на объект, но при --dump-single-json вывод
 * бывает и отформатированным. Сначала пробуем весь буфер целиком, потом построчно —
 * иначе многострочный ответ разбирается как первая строка и молча теряет состав.
 */
function lastJson(stdout: string): Info | null {
  const whole = stdout.trim();

  if (whole.startsWith('{')) {
    try {
      return JSON.parse(whole) as Info;
    } catch {
      // Скорее всего это несколько объектов подряд — разберём построчно.
    }
  }

  let found: Info | null = null;

  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;

    try {
      found = JSON.parse(trimmed) as Info;
    } catch {
      // Часть строк — не JSON, это нормально.
    }
  }

  return found;
}

async function onlyFile(dir: string): Promise<string | null> {
  const entries = await readdir(dir);
  const audio = entries.find((name) => name.startsWith('audio.'));
  return audio ? join(dir, audio) : null;
}

/**
 * Запуск без shell: аргументы уходят массивом, поэтому ссылка от пользователя
 * не может стать командой. Процесс убиваем по таймауту — yt-dlp умеет висеть
 * на медленном хосте бесконечно.
 */
function run(argv: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
  const [command, ...args] = argv;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      if (killed) {
        reject(new AppError('timeout', 'Загрузка заняла слишком долго и была прервана'));
        return;
      }

      if (code !== 0) {
        reject(new AppError('download_failed', explain(stderr)));
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

/** Из простыни yt-dlp вытаскиваем то, что человеку что-то говорит. */
function explain(stderr: string): string {
  const text = stderr.toLowerCase();

  if (text.includes('sign in to confirm') || text.includes('bot')) {
    return 'YouTube требует подтверждения, что запрос не от бота — с этого сервера скачать не выходит';
  }
  if (text.includes('video unavailable') || text.includes('private')) {
    return 'Ролик недоступен: удалён, приватный или заблокирован в стране сервера';
  }
  if (text.includes('ffmpeg')) {
    return 'На сервере нет ffmpeg — без него аудио не извлечь';
  }
  if (text.includes('file is larger') || text.includes('max-filesize')) {
    return `Файл больше ${config.downloadMaxMb} МБ`;
  }

  const line = stderr
    .split('\n')
    .map((item) => item.trim())
    .filter((item) => item.startsWith('ERROR:'))
    .pop();

  return line ? line.replace(/^ERROR:\s*/, '') : 'Скачать не получилось';
}
