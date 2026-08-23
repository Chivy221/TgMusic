import { addToLibrary, searchTracks, type Track } from './catalog.js';
import { addTrack } from './playlists.js';
import { fetcherAvailable, listPlaylist } from './fetcher.js';
import { config } from '../config.js';
import { AppError } from '../utils.js';

/**
 * Разбор ссылки с чужой площадки.
 *
 * Сначала ищем трек в общем каталоге: он уже лежит в Telegram, добавляется
 * мгновенно и ничего не стоит. Скачивание — второй шаг и отдельная кнопка,
 * потому что это единственное место, где байты идут через наш сервер.
 *
 * Трек-листы: Deezer и Apple Music отдают их открытым API, Spotify приходится
 * читать со страницы плеера, YouTube и SoundCloud разбирает yt-dlp. Яндекс
 * Музыка без OAuth-токена аккаунта не отдаёт ничего.
 */

export type ImportItem = {
  title: string;
  performer: string | null;
  /** Прямая ссылка на аудио, если площадка её даёт: с неё и качаем. */
  target?: string;
};

export type ImportEntry = {
  title: string;
  performer: string | null;
  trackId: number | null;
};

export type ImportResult = {
  source: string;
  kind: Kind;
  name: string;
  /** Часть трек-листа получить не удалось — площадка не отдаёт его без ключа. */
  partial: boolean;
  found: ImportEntry[];
  missing: ImportEntry[];
  /** Можно ли дозагрузить ненайденное: нужен yt-dlp на сервере. */
  canDownload: boolean;
};

type Kind = 'track' | 'album' | 'playlist';

type Parsed = { source: string; kind: Kind; id: string; url: string; extra?: string };

export type Resolved = {
  source: string;
  name: string;
  kind: Kind;
  items: ImportItem[];
  partial: boolean;
};

const TIMEOUT_MS = 8000;

export function looksLikeLink(text: string): boolean {
  return /^https?:\/\/\S+$/i.test(text.trim());
}

/**
 * Разбирает ссылку и добавляет в фонотеку то, что нашлось в каталоге, — а при
 * указанном плейлисте ещё и в него, сохраняя порядок исходного трек-листа.
 */
export async function importFromLink(
  userId: number,
  rawUrl: string,
  playlistId?: number,
): Promise<ImportResult> {
  const resolved = await resolveLink(rawUrl);

  const found: ImportEntry[] = [];
  const missing: ImportEntry[] = [];

  for (const item of resolved.items.slice(0, config.downloadMaxItems)) {
    const match = matchInCatalog(item);
    const entry: ImportEntry = {
      title: item.title,
      performer: item.performer,
      trackId: match?.id ?? null,
    };

    if (!match) {
      missing.push(entry);
      continue;
    }

    addToLibrary(userId, match.id);
    if (playlistId !== undefined) addTrack(playlistId, match.id);
    found.push(entry);
  }

  return {
    source: resolved.source,
    kind: resolved.kind,
    name: resolved.name,
    partial: resolved.partial,
    found,
    missing,
    canDownload: missing.length > 0 && (await fetcherAvailable()),
  };
}

/** Ссылка → состав. Общая точка для быстрого импорта и для загрузки файлов. */
export async function resolveLink(rawUrl: string): Promise<Resolved> {
  const parsed = parse(rawUrl);
  if (!parsed) {
    throw new AppError(
      'unsupported_link',
      'Не понимаю эту ссылку. Поддерживаю Deezer, Apple Music, Spotify, YouTube, SoundCloud и Яндекс Музыку.',
    );
  }

  const resolved = await resolve(parsed);
  if (!resolved || resolved.items.length === 0) {
    throw new AppError(
      'nothing_resolved',
      'По ссылке ничего не удалось прочитать — площадка не отдала список треков',
    );
  }

  return resolved;
}

/** Совпадение в общем каталоге, если оно есть. Наружу — для загрузчика. */
export function matchInCatalog(item: ImportItem): Track | null {
  const wantedTitle = normalize(item.title);
  if (!wantedTitle) return null;

  const wantedPerformer = normalize(item.performer ?? '');
  const candidates = searchTracks(core(item.title), 60);

  let best: { track: Track; score: number } | null = null;

  for (const track of candidates) {
    const title = normalize(track.title ?? '');
    if (!title) continue;

    let score = 0;
    if (title === wantedTitle) score += 3;
    else if (title.includes(wantedTitle) || wantedTitle.includes(title)) score += 1;
    else continue;

    const performer = normalize(track.performer ?? '');
    if (wantedPerformer && performer) {
      if (performer === wantedPerformer) score += 2;
      else if (performer.includes(wantedPerformer) || wantedPerformer.includes(performer)) score += 1;
      else score -= 1;
    }

    if (score > 0 && (!best || score > best.score)) best = { track, score };
  }

  return best?.track ?? null;
}

// ── Разбор ссылки ────────────────────────────────────────────────────────────

function parse(rawUrl: string): Parsed | null {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.replace(/^www\./, '');
  const path = url.pathname.split('/').filter(Boolean);
  const href = url.href;

  if (host.endsWith('deezer.com')) {
    // Ссылки бывают с языковым префиксом: deezer.com/ru/album/123
    const at = path.findIndex((part) => ['track', 'album', 'playlist'].includes(part));
    if (at === -1 || !path[at + 1]) return null;
    return { source: 'Deezer', kind: path[at] as Kind, id: path[at + 1], url: href };
  }

  if (host === 'music.apple.com' || host === 'itunes.apple.com') {
    const at = path.findIndex((part) => ['album', 'song', 'playlist'].includes(part));
    if (at === -1) return null;
    const id = path[path.length - 1];
    const song = url.searchParams.get('i');

    if (song) return { source: 'Apple Music', kind: 'track', id: song, url: href };
    if (path[at] === 'song') return { source: 'Apple Music', kind: 'track', id, url: href };
    if (path[at] === 'album') return { source: 'Apple Music', kind: 'album', id, url: href };
    return { source: 'Apple Music', kind: 'playlist', id, url: href };
  }

  if (host === 'open.spotify.com') {
    const at = path.findIndex((part) => ['track', 'album', 'playlist'].includes(part));
    if (at === -1 || !path[at + 1]) return null;
    return { source: 'Spotify', kind: path[at] as Kind, id: path[at + 1], url: href };
  }

  if (host === 'youtu.be') {
    return { source: 'YouTube', kind: 'track', id: path[0] ?? '', url: href };
  }

  if (host.endsWith('youtube.com')) {
    const list = url.searchParams.get('list');
    const video = url.searchParams.get('v');

    // Ссылка на ролик внутри плейлиста — это всё-таки ролик: человек прислал его.
    if (video) return { source: 'YouTube', kind: 'track', id: video, url: href };
    if (list) {
      return {
        source: 'YouTube',
        kind: 'playlist',
        id: list,
        url: `https://www.youtube.com/playlist?list=${list}`,
      };
    }
    return null;
  }

  if (host === 'soundcloud.com') {
    return {
      source: 'SoundCloud',
      kind: path.includes('sets') ? 'playlist' : 'track',
      id: href,
      url: href,
    };
  }

  if (host === 'music.yandex.ru' || host === 'music.yandex.com') {
    const trackAt = path.indexOf('track');
    if (trackAt !== -1 && path[trackAt + 1]) {
      return { source: 'Яндекс Музыка', kind: 'track', id: path[trackAt + 1], url: href };
    }

    const albumAt = path.indexOf('album');
    if (albumAt !== -1 && path[albumAt + 1]) {
      return { source: 'Яндекс Музыка', kind: 'album', id: path[albumAt + 1], url: href };
    }

    const listAt = path.indexOf('playlists');
    if (listAt !== -1 && path[listAt + 1]) {
      return {
        source: 'Яндекс Музыка',
        kind: 'playlist',
        id: path[listAt + 1],
        url: href,
        extra: path[1],
      };
    }
    return null;
  }

  return null;
}

async function resolve(parsed: Parsed): Promise<Resolved | null> {
  switch (parsed.source) {
    case 'Deezer':
      return resolveDeezer(parsed);
    case 'Apple Music':
      return resolveApple(parsed);
    case 'Spotify':
      return resolveSpotify(parsed);
    case 'YouTube':
    case 'SoundCloud':
      return resolveStreamable(parsed);
    case 'Яндекс Музыка':
      return resolveYandex(parsed);
    default:
      return null;
  }
}

// ── Площадки с открытым API ──────────────────────────────────────────────────

type DeezerTrack = { title?: string; artist?: { name?: string } };

async function resolveDeezer(parsed: Parsed): Promise<Resolved | null> {
  const data = await getJson<DeezerTrack & { name?: string; tracks?: { data?: DeezerTrack[] } }>(
    `https://api.deezer.com/${parsed.kind}/${parsed.id}`,
  );
  if (!data) return null;

  if (parsed.kind === 'track') {
    if (!data.title) return null;
    return {
      source: parsed.source,
      kind: 'track',
      name: data.title,
      items: [{ title: data.title, performer: data.artist?.name ?? null }],
      partial: false,
    };
  }

  const items = (data.tracks?.data ?? [])
    .filter((track): track is DeezerTrack & { title: string } => Boolean(track.title))
    .map((track) => ({ title: track.title, performer: track.artist?.name ?? null }));

  return {
    source: parsed.source,
    kind: parsed.kind,
    name: data.title ?? data.name ?? 'Без названия',
    items,
    partial: false,
  };
}

type ItunesItem = {
  wrapperType?: string;
  trackName?: string;
  artistName?: string;
  collectionName?: string;
};

async function resolveApple(parsed: Parsed): Promise<Resolved | null> {
  // Плейлисты Apple Music (pl.…) публичного API не имеют — только альбомы и треки.
  if (parsed.kind === 'playlist') {
    throw new AppError(
      'apple_playlist_unsupported',
      'Плейлисты Apple Music без ключа не читаются. Альбом или отдельный трек — пожалуйста.',
    );
  }

  const data = await getJson<{ results?: ItunesItem[] }>(
    `https://itunes.apple.com/lookup?id=${encodeURIComponent(parsed.id)}&entity=song&limit=200`,
  );

  const results = data?.results ?? [];
  if (results.length === 0) return null;

  const songs = results.filter((item) => item.wrapperType === 'track' && item.trackName);
  const items = songs.map((song) => ({
    title: song.trackName!,
    performer: song.artistName ?? null,
  }));

  return {
    source: parsed.source,
    kind: parsed.kind,
    name: results[0]?.collectionName ?? items[0]?.title ?? 'Без названия',
    items,
    partial: false,
  };
}

// ── Площадки без API: читаем то, что отдают публично ──────────────────────────

type SpotifyEntity = {
  name?: string;
  title?: string;
  subtitle?: string;
  artists?: Array<{ name?: string }>;
  trackList?: Array<{ title?: string; subtitle?: string }>;
};

/**
 * У Spotify открытого API без ключа нет, но страница плеера отдаёт трек-лист
 * внутри `__NEXT_DATA__`. Это не контракт, а наблюдение — поэтому при любой
 * неудаче откатываемся на oEmbed, где есть хотя бы название.
 */
async function resolveSpotify(parsed: Parsed): Promise<Resolved | null> {
  const html = await getText(`https://open.spotify.com/embed/${parsed.kind}/${parsed.id}`);
  const entity = html ? extractSpotifyEntity(html) : null;

  if (entity) {
    const list = entity.trackList ?? [];
    const name = entity.name ?? entity.title ?? 'Без названия';

    if (parsed.kind === 'track') {
      const title = entity.name ?? entity.title;
      if (title) {
        return {
          source: parsed.source,
          kind: 'track',
          name: title,
          items: [{ title, performer: entity.artists?.[0]?.name ?? entity.subtitle ?? null }],
          partial: false,
        };
      }
    }

    if (list.length > 0) {
      return {
        source: parsed.source,
        kind: parsed.kind,
        name,
        items: list
          .filter((item): item is { title: string; subtitle?: string } => Boolean(item.title))
          .map((item) => ({ title: item.title, performer: item.subtitle ?? null })),
        partial: false,
      };
    }
  }

  const fallback = await getJson<{ title?: string }>(
    `https://open.spotify.com/oembed?url=${encodeURIComponent(`https://open.spotify.com/${parsed.kind}/${parsed.id}`)}`,
  );
  if (!fallback?.title) return null;

  const split = splitArtistTitle(fallback.title);
  return {
    source: parsed.source,
    kind: parsed.kind,
    name: fallback.title,
    items: parsed.kind === 'track' ? [split] : [],
    partial: parsed.kind !== 'track',
  };
}

function extractSpotifyEntity(html: string): SpotifyEntity | null {
  const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!match) return null;

  try {
    const data = JSON.parse(match[1]) as {
      props?: { pageProps?: { state?: { data?: { entity?: SpotifyEntity } } } };
    };
    return data.props?.pageProps?.state?.data?.entity ?? null;
  } catch {
    return null;
  }
}

/**
 * YouTube и SoundCloud — единственные площадки, с которых аудио реально скачивается,
 * поэтому у их треков есть прямая цель для загрузки. Состав плейлиста своего API
 * они не отдают: там, где есть yt-dlp, состав разбирает он, иначе остаётся oEmbed
 * с одним названием на весь плейлист.
 */
async function resolveStreamable(parsed: Parsed): Promise<Resolved | null> {
  if (parsed.kind === 'playlist' && (await fetcherAvailable())) {
    // Плейлист может оказаться приватным или пустым — это не повод ронять разбор:
    // ниже остаётся oEmbed, который хотя бы вернёт название.
    const entries = await listPlaylist(parsed.url).catch((error) => {
      console.warn('[import] состав плейлиста не прочитан', String(error));
      return [];
    });

    if (entries.length > 0) {
      return {
        source: parsed.source,
        kind: 'playlist',
        name: `Плейлист ${parsed.source}`,
        items: entries.map((entry) => ({
          title: entry.title,
          performer: entry.performer,
          target: entry.url,
        })),
        partial: false,
      };
    }
  }

  const endpoint =
    parsed.source === 'YouTube'
      ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(parsed.url)}`
      : `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(parsed.url)}`;

  const data = await getJson<{ title?: string; author_name?: string }>(endpoint);
  if (!data?.title) return null;

  if (parsed.kind === 'playlist') {
    return { source: parsed.source, kind: 'playlist', name: data.title, items: [], partial: true };
  }

  const split = splitArtistTitle(data.title, data.author_name);
  return {
    source: parsed.source,
    kind: 'track',
    name: data.title,
    items: [{ ...split, target: parsed.url }],
    partial: false,
  };
}

type YandexTrack = { title?: string; artists?: Array<{ name?: string }> };

/**
 * У Яндекс Музыки открытого API нет: api.music.yandex.net отвечает 403 без
 * OAuth-токена аккаунта. Разбор оставлен на случай, если токен появится в
 * окружении, но по умолчанию ссылка честно отбивается понятной ошибкой.
 */
async function resolveYandex(parsed: Parsed): Promise<Resolved | null> {
  const endpoint =
    parsed.kind === 'track'
      ? `https://api.music.yandex.net/tracks/${parsed.id}`
      : parsed.kind === 'album'
        ? `https://api.music.yandex.net/albums/${parsed.id}/with-tracks`
        : `https://api.music.yandex.net/users/${parsed.extra}/playlists/${parsed.id}`;

  const data = await getJson<{
    result?:
      | YandexTrack[]
      | { title?: string; volumes?: YandexTrack[][]; tracks?: Array<{ track?: YandexTrack }> };
  }>(endpoint);

  const result = data?.result;
  if (!result) {
    throw new AppError(
      'yandex_unavailable',
      'Яндекс Музыка не отдаёт данные без токена аккаунта. Пришли ссылку с Deezer, Apple Music, Spotify, YouTube или SoundCloud.',
    );
  }

  if (Array.isArray(result)) {
    const track = result[0];
    if (!track?.title) return null;
    return {
      source: parsed.source,
      kind: 'track',
      name: track.title,
      items: [{ title: track.title, performer: track.artists?.[0]?.name ?? null }],
      partial: false,
    };
  }

  const flat = [
    ...(result.volumes ?? []).flat(),
    ...(result.tracks ?? []).map((item) => item.track).filter(Boolean),
  ] as YandexTrack[];

  return {
    source: parsed.source,
    kind: parsed.kind,
    name: result.title ?? 'Без названия',
    items: flat
      .filter((track): track is YandexTrack & { title: string } => Boolean(track.title))
      .map((track) => ({ title: track.title, performer: track.artists?.[0]?.name ?? null })),
    partial: false,
  };
}

// ── Сопоставление с каталогом ────────────────────────────────────────────────

/** Ядро названия для LIKE-поиска: первые слова без скобок и мусора. */
function core(title: string): string {
  return normalize(title).split(' ').slice(0, 3).join(' ');
}

/**
 * Названия с площадок и теги из файлов совпадают редко: у одних «feat.»,
 * у других «(Remastered 2011)». Чистим и то и другое перед сравнением.
 */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, ' ')
    .replace(/\b(feat|ft|prod|remastered|official|video|audio|lyrics)\b.*/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Площадки без структурированных данных отдают одну строку: YouTube обычно
 * «Artist - Title», SoundCloud — «Title by Artist». Разбираем оба вида, иначе
 * исполнитель уезжает в название и совпадение не находится.
 */
function splitArtistTitle(value: string, author?: string): ImportItem {
  const performer = author?.replace(/\s*-\s*Topic$/, '').trim() || null;

  const dashed = value.split(/\s[-–—]\s/);
  if (dashed.length >= 2) {
    return { title: dashed.slice(1).join(' - ').trim(), performer: dashed[0].trim() };
  }

  const by = value.match(/^(.+?)\s+by\s+(.+)$/i);
  if (by) return { title: by[1].trim(), performer: by[2].trim() };

  return { title: value.trim(), performer };
}

// ── Сеть ─────────────────────────────────────────────────────────────────────

async function getJson<T>(url: string): Promise<T | null> {
  const text = await getText(url);
  if (text === null) return null;

  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function getText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; telemusic)' },
    });
    if (!response.ok) return null;
    return await response.text();
  } catch (error) {
    console.warn('[import] запрос не удался', url, String(error));
    return null;
  }
}
