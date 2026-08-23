import { insideTelegram, sessionToken, tg } from './telegram';

const BASE = import.meta.env.VITE_API_URL ?? '';

/** Внутри Telegram — подпись initData, в установленном PWA — токен сессии. */
function authorization(): string {
  if (insideTelegram()) return `tma ${tg?.initData}`;

  const token = sessionToken();
  return token ? `Bearer ${token}` : '';
}

export type Track = {
  id: number;
  title: string | null;
  performer: string | null;
  duration: number | null;
};

export type Playlist = {
  id: number;
  title: string;
  isPublic: number;
  slug: string | null;
  sourcePlaylistId: number | null;
  /** Группа-источник, если плейлист собран из чата. */
  sourceChatId: number | null;
  syncEnabled: number;
  trackCount?: number;
};

export type PlayResult = {
  url: string;
  total: number;
  posted: number;
};

export type PlatformLink = { platform: string; url: string; exact: boolean };

/** Группа, куда добавлен бот. Из таких и выбирается плеер. */
export type KnownChat = {
  id: number;
  title: string;
  type: string;
  isAdmin: boolean;
  canDelete: boolean;
  isPlayer: boolean;
};

export type ImportEntry = { title: string; performer: string | null; trackId: number | null };

export type ImportResult = {
  source: string;
  kind: 'track' | 'album' | 'playlist';
  name: string;
  partial: boolean;
  found: ImportEntry[];
  missing: ImportEntry[];
  /** Есть ли чем дозагрузить ненайденное: на сервере должен стоять yt-dlp. */
  canDownload: boolean;
};

export type DownloadJob = {
  id: string;
  state: 'running' | 'done' | 'failed';
  name: string;
  source: string;
  total: number;
  done: number;
  added: Array<{ title: string; performer: string | null; trackId: number; downloaded: boolean }>;
  failed: Array<{ title: string; performer: string | null; reason: string }>;
  error: string | null;
};

/**
 * Что стало с личной копией файла после переименования. Telegram показывает теги
 * из самого файла, поэтому правка видна в плеере только после перезаливки.
 */
export type VariantStatus = 'applied' | 'reverted' | 'unchanged' | 'too_big' | 'failed';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${BASE}/api${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: authorization(),
      ...init?.headers,
    },
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new ApiError(body.error ?? 'unknown', body.message ?? 'Что-то пошло не так');
  }
  return body as T;
}

export const api = {
  me: () =>
    request<{ hasPlayerChat: boolean; playerChatTitle: string | null; firstName?: string }>('/me'),

  createSession: () => request<{ token: string; url: string }>('/session', { method: 'POST' }),

  library: () => request<{ tracks: Track[] }>('/library'),

  playlists: () => request<{ playlists: Playlist[] }>('/playlists'),

  playlist: (id: number) => request<{ playlist: Playlist; tracks: Track[] }>(`/playlists/${id}`),

  createPlaylist: (title: string) =>
    request<{ playlist: Playlist }>('/playlists', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),

  mergeAll: (title?: string) =>
    request<{ playlist: Playlist }>('/playlists/merge', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),

  renamePlaylist: (id: number, title: string) =>
    request<{ playlist: Playlist }>(`/playlists/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  setSync: (id: number, syncEnabled: boolean) =>
    request<{ playlist: Playlist }>(`/playlists/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ syncEnabled }),
    }),

  deletePlaylist: (id: number) => request(`/playlists/${id}`, { method: 'DELETE' }),

  addTrack: (playlistId: number, trackId: number) =>
    request(`/playlists/${playlistId}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ trackId }),
    }),

  removeTrack: (playlistId: number, trackId: number) =>
    request(`/playlists/${playlistId}/tracks/${trackId}`, { method: 'DELETE' }),

  play: (id: number, fromTrackId?: number) =>
    request<PlayResult>(`/playlists/${id}/play`, {
      method: 'POST',
      body: JSON.stringify({ fromTrackId }),
    }),

  playTrack: (trackId: number) => request<PlayResult>(`/tracks/${trackId}/play`, { method: 'POST' }),

  clearPlayer: () => request<{ deleted: number }>('/player/clear', { method: 'POST' }),

  chats: () => request<{ chats: KnownChat[] }>('/chats'),

  setPlayer: (chatId: number) =>
    request<{ chat: KnownChat }>('/player', { method: 'POST', body: JSON.stringify({ chatId }) }),

  disconnectPlayer: () => request('/player', { method: 'DELETE' }),

  importLink: (url: string, playlistId?: number) =>
    request<ImportResult>('/import', {
      method: 'POST',
      body: JSON.stringify({ url, playlistId }),
    }),

  startDownload: (url: string, playlistId?: number) =>
    request<{ job: DownloadJob }>('/import/download', {
      method: 'POST',
      body: JSON.stringify({ url, playlistId }),
    }),

  downloadJob: (id: string) => request<{ job: DownloadJob }>(`/import/jobs/${id}`),

  renameTrack: (id: number, values: { title?: string | null; performer?: string | null }) =>
    request<{ track: Track; variant: VariantStatus }>(`/tracks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(values),
    }),

  sendTrack: (id: number) => request(`/tracks/${id}/send`, { method: 'POST' }),

  links: (id: number) => request<{ links: PlatformLink[] }>(`/tracks/${id}/links`),

  publish: (id: number) =>
    request<{ playlist: Playlist; shareUrl: string }>(`/playlists/${id}/publish`, { method: 'POST' }),

  shared: (slug: string) =>
    request<{
      playlist: Playlist;
      owner: { username?: string; firstName?: string };
      tracks: Track[];
      isMine: boolean;
    }>(`/shared/${slug}`),

  addShared: (slug: string) =>
    request<{ playlist: Playlist }>(`/shared/${slug}/add`, { method: 'POST' }),
};
