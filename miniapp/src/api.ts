import { tg } from './telegram';

const BASE = import.meta.env.VITE_API_URL ?? '';

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
  trackCount?: number;
};

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
      // Единственная авторизация: сервер проверяет подпись initData ключом от токена бота.
      Authorization: `tma ${tg?.initData ?? ''}`,
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
  me: () => request<{ hasPlaybackChannel: boolean; firstName?: string }>('/me'),

  library: () => request<{ tracks: Track[] }>('/library'),

  playlists: () => request<{ playlists: Playlist[] }>('/playlists'),

  playlist: (id: number) => request<{ playlist: Playlist; tracks: Track[] }>(`/playlists/${id}`),

  createPlaylist: (title: string) =>
    request<{ playlist: Playlist }>('/playlists', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),

  deletePlaylist: (id: number) => request(`/playlists/${id}`, { method: 'DELETE' }),

  addTrack: (playlistId: number, trackId: number) =>
    request(`/playlists/${playlistId}/tracks`, {
      method: 'POST',
      body: JSON.stringify({ trackId }),
    }),

  removeTrack: (playlistId: number, trackId: number) =>
    request(`/playlists/${playlistId}/tracks/${trackId}`, { method: 'DELETE' }),

  play: (id: number) =>
    request<{ url: string; total: number; posted: number }>(`/playlists/${id}/play`, {
      method: 'POST',
    }),

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
