import type { Track } from './catalog.js';

export type PlatformLink = { platform: string; url: string; exact: boolean };

/**
 * Ссылки на трек в других сервисах.
 *
 * Точные ссылки берём там, где есть открытый API без ключа: iTunes Search и Deezer.
 * Для остальных площадок отдаём ссылку на поиск — это честнее, чем ничего,
 * и не требует ни ключей, ни договорённостей.
 *
 * Odesli (song.link) сюда напрашивался, но его публичный API закрыт:
 * отвечает 401 PUBLIC_API_ACCESS_DEPRECATED и требует ключ.
 */
const cache = new Map<number, { links: PlatformLink[]; expiresAt: number }>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 6000;

export async function findLinks(track: Track): Promise<PlatformLink[]> {
  const cached = cache.get(track.id);
  if (cached && cached.expiresAt > Date.now()) return cached.links;

  const query = [track.performer, track.title].filter(Boolean).join(' ').trim();
  if (!query) return [];

  // Точные ссылки ищем параллельно: оба сервиса независимы.
  const [apple, deezer] = await Promise.all([searchItunes(query), searchDeezer(query)]);

  const links: PlatformLink[] = [];
  if (apple) links.push({ platform: 'Apple Music', url: apple, exact: true });
  if (deezer) links.push({ platform: 'Deezer', url: deezer, exact: true });

  const encoded = encodeURIComponent(query);
  links.push(
    { platform: 'Spotify', url: `https://open.spotify.com/search/${encoded}`, exact: false },
    { platform: 'YouTube', url: `https://www.youtube.com/results?search_query=${encoded}`, exact: false },
    { platform: 'Яндекс Музыка', url: `https://music.yandex.ru/search?text=${encoded}`, exact: false },
    { platform: 'SoundCloud', url: `https://soundcloud.com/search?q=${encoded}`, exact: false },
  );

  cache.set(track.id, { links, expiresAt: Date.now() + CACHE_TTL_MS });
  return links;
}

async function searchItunes(query: string): Promise<string | null> {
  const data = await getJson<{ results?: Array<{ trackViewUrl?: string }> }>(
    `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=1`,
  );

  return data?.results?.[0]?.trackViewUrl ?? null;
}

async function searchDeezer(query: string): Promise<string | null> {
  const data = await getJson<{ data?: Array<{ link?: string }> }>(
    `https://api.deezer.com/search?q=${encodeURIComponent(query)}&limit=1`,
  );

  return data?.data?.[0]?.link ?? null;
}

/** Внешние сервисы не должны подвешивать наш запрос — таймаут и мягкий отказ. */
async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch (error) {
    console.warn('[links] запрос не удался', url, String(error));
    return null;
  }
}
