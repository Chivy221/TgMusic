import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type Playlist, type Track } from './api';
import { haptic, sharedSlug, tg } from './telegram';

type View =
  | { name: 'library' }
  | { name: 'playlists' }
  | { name: 'playlist'; id: number }
  | { name: 'shared'; slug: string };

export function App() {
  const slug = sharedSlug();
  const [view, setView] = useState<View>(slug ? { name: 'shared', slug } : { name: 'playlists' });
  const [hasChannel, setHasChannel] = useState(true);

  useEffect(() => {
    api.me()
      .then((me) => setHasChannel(me.hasPlaybackChannel))
      .catch(() => undefined);
  }, []);

  if (view.name === 'shared') {
    return <SharedView slug={view.slug} onDone={() => setView({ name: 'playlists' })} />;
  }

  if (view.name === 'playlist') {
    return (
      <PlaylistView
        id={view.id}
        hasChannel={hasChannel}
        onBack={() => setView({ name: 'playlists' })}
      />
    );
  }

  return (
    <div className="app">
      <div className="tabs">
        <button
          className="tab"
          data-active={view.name === 'playlists'}
          onClick={() => setView({ name: 'playlists' })}
        >
          Плейлисты
        </button>
        <button
          className="tab"
          data-active={view.name === 'library'}
          onClick={() => setView({ name: 'library' })}
        >
          Библиотека
        </button>
      </div>

      {!hasChannel && <ChannelNotice />}

      {view.name === 'playlists' ? (
        <PlaylistsView onOpen={(id) => setView({ name: 'playlist', id })} />
      ) : (
        <LibraryView />
      )}
    </div>
  );
}

function ChannelNotice() {
  return (
    <div className="notice">
      Чтобы слушать штатным плеером Telegram — с фоном и экраном блокировки — подключи канал:
      <ol>
        <li>создай приватный канал, например «Моя музыка»</li>
        <li>добавь бота админом с правом публикации и удаления</li>
      </ol>
    </div>
  );
}

function PlaylistsView({ onOpen }: { onOpen: (id: number) => void }) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    api.playlists()
      .then((data) => setPlaylists(data.playlists))
      .finally(() => setLoading(false));
  }, []);

  useEffect(reload, [reload]);

  async function create() {
    if (!title.trim()) return;
    await api.createPlaylist(title);
    setTitle('');
    reload();
  }

  return (
    <>
      <div className="actions">
        <input
          className="input"
          placeholder="Новый плейлист"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && create()}
        />
        <button className="btn" onClick={create} disabled={!title.trim()}>
          Создать
        </button>
      </div>

      {loading ? null : playlists.length === 0 ? (
        <div className="empty">Пока пусто. Создай первый плейлист.</div>
      ) : (
        playlists.map((playlist) => (
          <div className="card" key={playlist.id} onClick={() => onOpen(playlist.id)}>
            <div className="row">
              <div className="grow">
                <div className="title">{playlist.title}</div>
                <div className="sub">
                  {playlist.trackCount ?? 0} треков
                  {playlist.isPublic ? ' · опубликован' : ''}
                  {playlist.sourcePlaylistId ? ' · добавлен' : ''}
                </div>
              </div>
              <span className="sub">›</span>
            </div>
          </div>
        ))
      )}
    </>
  );
}

function LibraryView() {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [picking, setPicking] = useState<Track | null>(null);

  useEffect(() => {
    api.library().then((data) => setTracks(data.tracks));
    api.playlists().then((data) => setPlaylists(data.playlists));
  }, []);

  async function add(playlistId: number) {
    if (!picking) return;
    await api.addTrack(playlistId, picking.id);
    setPicking(null);
    haptic();
  }

  if (picking) {
    return (
      <>
        <div className="header">
          <button className="back" onClick={() => setPicking(null)}>
            ‹ Отмена
          </button>
          <div className="grow title">{trackName(picking)}</div>
        </div>
        <div className="hint">В какой плейлист добавить?</div>
        {playlists.map((playlist) => (
          <div className="card" key={playlist.id} onClick={() => add(playlist.id)}>
            <div className="title">{playlist.title}</div>
          </div>
        ))}
      </>
    );
  }

  if (tracks.length === 0) {
    return <div className="empty">Отправь боту любые аудиофайлы — они появятся здесь.</div>;
  }

  return (
    <>
      {tracks.map((track) => (
        <div className="card" key={track.id}>
          <div className="row">
            <div className="grow">
              <div className="title">{track.title ?? 'Без названия'}</div>
              <div className="sub">
                {track.performer ?? 'Неизвестный исполнитель'} · {formatDuration(track.duration)}
              </div>
            </div>
            <button className="btn small ghost" onClick={() => setPicking(track)}>
              В плейлист
            </button>
          </div>
        </div>
      ))}
    </>
  );
}

function PlaylistView({
  id,
  hasChannel,
  onBack,
}: {
  id: number;
  hasChannel: boolean;
  onBack: () => void;
}) {
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(() => {
    api.playlist(id).then((data) => {
      setPlaylist(data.playlist);
      setTracks(data.tracks);
    });
  }, [id]);

  useEffect(reload, [reload]);

  /**
   * Сервер выкладывает треки в канал и возвращает ссылку на первый.
   * Запустить проигрывание из мини-аппа нельзя — Telegram не даёт такого API,
   * поэтому просто открываем канал на первом треке: дальше один тап пользователя.
   */
  async function play() {
    setBusy(true);
    try {
      const result = await api.play(id);
      tg?.openTelegramLink(result.url);
    } catch (error) {
      const message =
        error instanceof ApiError && error.code === 'no_playback_channel'
          ? 'Сначала создай приватный канал и добавь бота админом.'
          : error instanceof ApiError
            ? error.message
            : 'Не получилось';
      tg?.showAlert(message);
    } finally {
      setBusy(false);
    }
  }

  async function share() {
    const { shareUrl } = await api.publish(id);
    reload();
    tg?.showAlert(`Ссылка на плейлист:\n${shareUrl}`);
  }

  async function remove(trackId: number) {
    await api.removeTrack(id, trackId);
    reload();
  }

  if (!playlist) return null;

  return (
    <div className="app">
      <div className="header">
        <button className="back" onClick={onBack}>
          ‹ Назад
        </button>
        <div className="grow title">{playlist.title}</div>
      </div>

      <div className="actions">
        <button className="btn grow" onClick={play} disabled={busy || tracks.length === 0}>
          {busy ? 'Готовлю…' : '▶ Слушать в Telegram'}
        </button>
        <button className="btn ghost" onClick={share}>
          {playlist.isPublic ? 'Ссылка' : 'Опубликовать'}
        </button>
      </div>

      {!hasChannel && <ChannelNotice />}

      {tracks.length === 0 ? (
        <div className="empty">Добавь треки из библиотеки.</div>
      ) : (
        tracks.map((track, index) => (
          <div className="card" key={track.id}>
            <div className="row">
              <span className="sub">{index + 1}</span>
              <div className="grow">
                <div className="title">{track.title ?? 'Без названия'}</div>
                <div className="sub">
                  {track.performer ?? 'Неизвестный исполнитель'} · {formatDuration(track.duration)}
                </div>
              </div>
              <button className="btn small danger" onClick={() => remove(track.id)}>
                Убрать
              </button>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function SharedView({ slug, onDone }: { slug: string; onDone: () => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.shared>> | null>(null);
  const [added, setAdded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.shared(slug)
      .then(setData)
      .catch(() => setError('Плейлист не найден или снят с публикации'));
  }, [slug]);

  async function add() {
    await api.addShared(slug);
    setAdded(true);
    haptic();
  }

  if (error) return <div className="app"><div className="empty">{error}</div></div>;
  if (!data) return null;

  const author = data.owner.username ? `@${data.owner.username}` : (data.owner.firstName ?? 'кто-то');

  return (
    <div className="app">
      <div className="header">
        <div className="grow">
          <div className="title">{data.playlist.title}</div>
          <div className="sub">
            {data.tracks.length} треков · от {author}
          </div>
        </div>
      </div>

      <div className="actions">
        {added ? (
          <button className="btn grow" onClick={onDone}>
            Готово, открыть мои плейлисты
          </button>
        ) : (
          <button className="btn grow" onClick={add} disabled={data.isMine}>
            {data.isMine ? 'Это твой плейлист' : 'Добавить себе'}
          </button>
        )}
      </div>

      {data.tracks.map((track) => (
        <div className="card" key={track.id}>
          <div className="title">{track.title ?? 'Без названия'}</div>
          <div className="sub">
            {track.performer ?? 'Неизвестный исполнитель'} · {formatDuration(track.duration)}
          </div>
        </div>
      ))}
    </div>
  );
}

function trackName(track: Track): string {
  return [track.performer, track.title].filter(Boolean).join(' — ') || 'Трек';
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
