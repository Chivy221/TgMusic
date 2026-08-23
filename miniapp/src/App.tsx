import { useCallback, useEffect, useState } from 'react';
import { ApiError, api, type PlatformLink, type PlayResult, type Playlist, type Track } from './api';
import { alert, haptic, insideTelegram, sessionToken, sharedSlug, tg } from './telegram';

type View =
  | { name: 'library' }
  | { name: 'playlists' }
  | { name: 'playlist'; id: number }
  | { name: 'shared'; slug: string };

type Me = { hasPlayerChat: boolean; playerChatTitle: string | null };

export function App() {
  const slug = sharedSlug();
  const [view, setView] = useState<View>(slug ? { name: 'shared', slug } : { name: 'playlists' });
  const [me, setMe] = useState<Me | null>(null);

  const reloadMe = useCallback(() => {
    api.me()
      .then((data) => setMe({ hasPlayerChat: data.hasPlayerChat, playerChatTitle: data.playerChatTitle }))
      .catch(() => undefined);
  }, []);

  useEffect(reloadMe, [reloadMe]);

  if (!insideTelegram() && !sessionToken()) {
    return (
      <div className="app">
        <div className="empty">Открой настройки через бота в Telegram.</div>
      </div>
    );
  }

  if (view.name === 'shared') {
    return <SharedView slug={view.slug} onDone={() => setView({ name: 'playlists' })} />;
  }

  if (view.name === 'playlist') {
    return <PlaylistView id={view.id} me={me} onBack={() => setView({ name: 'playlists' })} />;
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

      <PlayerChat me={me} onChange={reloadMe} />

      {view.name === 'playlists' ? (
        <PlaylistsView onOpen={(id) => setView({ name: 'playlist', id })} />
      ) : (
        <LibraryView />
      )}
    </div>
  );
}

/** Группа, в которую бот выкладывает треки, — это и есть плеер. */
function PlayerChat({ me, onChange }: { me: Me | null; onChange: () => void }) {
  const [busy, setBusy] = useState(false);

  async function clear() {
    setBusy(true);
    try {
      const { deleted } = await api.clearPlayer();
      alert(deleted > 0 ? `Убрано сообщений: ${deleted}` : 'Плеер уже пуст');
      onChange();
    } catch (error) {
      alert(describe(error));
    } finally {
      setBusy(false);
    }
  }

  if (!me) return null;

  if (!me.hasPlayerChat) {
    return (
      <div className="notice">
        <b>Плеер не подключён.</b>
        <ol>
          <li>создай группу — она будет играть роль плеера</li>
          <li>добавь туда бота и выдай права администратора</li>
          <li>отключи в ней уведомления, иначе каждый трек будет пиликать</li>
        </ol>
        Без прав администратора бот не сможет убирать прошлый плейлист.
      </div>
    );
  }

  return (
    <div className="notice">
      <div className="row">
        <div className="grow">
          Плеер: <b>{me.playerChatTitle ?? 'группа подключена'}</b>
        </div>
        <button className="btn small ghost" onClick={clear} disabled={busy}>
          Очистить
        </button>
      </div>
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

  async function merge() {
    try {
      await api.mergeAll();
      haptic();
      reload();
    } catch (error) {
      alert(describe(error));
    }
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

      <div className="actions">
        <button className="btn ghost grow" onClick={merge}>
          🔀 Смешать все в один
        </button>
      </div>

      {loading ? null : playlists.length === 0 ? (
        <div className="empty">
          Пусто. Создай плейлист здесь или командой /new в боте — там можно сразу накидать треки.
        </div>
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
                  {playlist.sourceChatId
                    ? playlist.syncEnabled
                      ? ' · следит за группой'
                      : ' · из группы'
                    : ''}
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
  const [editing, setEditing] = useState<Track | null>(null);

  const reload = useCallback(() => {
    api.library().then((data) => setTracks(data.tracks));
  }, []);

  useEffect(() => {
    reload();
    api.playlists().then((data) => setPlaylists(data.playlists));
  }, [reload]);

  async function add(playlistId: number) {
    if (!picking) return;
    await api.addTrack(playlistId, picking.id);
    setPicking(null);
    haptic();
  }

  if (editing) {
    return (
      <TrackEditor
        track={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    );
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
            <div className="grow" onClick={() => setEditing(track)}>
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
      <div className="hint">Нажми на трек, чтобы переименовать, получить файл или найти ссылки.</div>
    </>
  );
}

/** Переименование, файл и ссылки на другие площадки — всё по одному треку. */
function TrackEditor({
  track,
  onClose,
  onSaved,
}: {
  track: Track;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(track.title ?? '');
  const [performer, setPerformer] = useState(track.performer ?? '');
  const [links, setLinks] = useState<PlatformLink[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function save() {
    setBusy('save');
    try {
      await api.renameTrack(track.id, { title, performer });
      haptic();
      onSaved();
    } catch (error) {
      alert(describe(error));
    } finally {
      setBusy(null);
    }
  }

  async function sendFile() {
    setBusy('send');
    try {
      await api.sendTrack(track.id);
      alert('Файл отправлен в переписку с ботом');
    } catch (error) {
      alert(describe(error));
    } finally {
      setBusy(null);
    }
  }

  async function loadLinks() {
    setBusy('links');
    try {
      const { links: found } = await api.links(track.id);
      setLinks(found);
      if (found.length === 0) alert('Ничего не нашлось — попробуй уточнить название и исполнителя');
    } catch (error) {
      alert(describe(error));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="header">
        <button className="back" onClick={onClose}>
          ‹ Назад
        </button>
        <div className="grow title">Трек</div>
      </div>

      <div className="field">
        <label className="sub">Название</label>
        <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} />
      </div>

      <div className="field">
        <label className="sub">Исполнитель</label>
        <input
          className="input"
          value={performer}
          onChange={(event) => setPerformer(event.target.value)}
        />
      </div>

      <div className="hint">
        Правки видны только тебе: файл в каталоге общий и может лежать в фонотеках других людей.
        Пустые поля вернут исходное название из тегов.
      </div>

      <div className="actions">
        <button className="btn grow" onClick={save} disabled={busy !== null}>
          {busy === 'save' ? 'Сохраняю…' : 'Сохранить'}
        </button>
      </div>

      <div className="actions">
        <button className="btn ghost grow" onClick={sendFile} disabled={busy !== null}>
          {busy === 'send' ? 'Отправляю…' : '⬇ Получить файл'}
        </button>
        <button className="btn ghost grow" onClick={loadLinks} disabled={busy !== null}>
          {busy === 'links' ? 'Ищу…' : '🔗 Ссылки'}
        </button>
      </div>

      {links?.map((link) => (
        <div className="card" key={link.platform} onClick={() => tg?.openLink(link.url)}>
          <div className="row">
            <div className="grow">
              <div className="title">{link.platform}</div>
              {!link.exact && <div className="sub">поиск по названию</div>}
            </div>
            <span className="sub">↗</span>
          </div>
        </div>
      ))}
    </>
  );
}

function PlaylistView({ id, me, onBack }: { id: number; me: Me | null; onBack: () => void }) {
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState('');

  const reload = useCallback(() => {
    api.playlist(id).then((data) => {
      setPlaylist(data.playlist);
      setTracks(data.tracks);
      setRenaming(data.playlist.title);
    });
  }, [id]);

  useEffect(reload, [reload]);

  /**
   * Выкладывает плейлист в группу-плеер. Отследить, что трек дослушан, Telegram
   * не даёт, поэтому кладём всё целиком — дальше нативный плеер идёт подряд сам.
   */
  async function play(fromTrackId?: number) {
    setBusy(true);
    try {
      const result: PlayResult = await api.play(id, fromTrackId);
      haptic();
      tg?.openTelegramLink(result.url);
    } catch (error) {
      alert(describe(error));
    } finally {
      setBusy(false);
    }
  }

  async function rename() {
    if (!renaming.trim() || renaming === playlist?.title) return;
    await api.renamePlaylist(id, renaming);
    reload();
    haptic();
  }

  async function toggleSync() {
    if (!playlist) return;
    try {
      await api.setSync(id, playlist.syncEnabled === 0);
      reload();
      haptic();
    } catch (error) {
      alert(describe(error));
    }
  }

  async function remove() {
    await api.deletePlaylist(id);
    onBack();
  }

  async function share() {
    const { shareUrl } = await api.publish(id);
    reload();
    alert(`Ссылка на плейлист:\n${shareUrl}`);
  }

  if (!playlist) return null;

  return (
    <div className="app">
      <div className="header">
        <button className="back" onClick={onBack}>
          ‹ Назад
        </button>
        <input
          className="input"
          value={renaming}
          onChange={(event) => setRenaming(event.target.value)}
          onBlur={rename}
          onKeyDown={(event) => event.key === 'Enter' && rename()}
        />
      </div>

      <div className="actions">
        <button className="btn grow" onClick={() => play()} disabled={busy || tracks.length === 0}>
          {busy ? 'Выкладываю…' : '▶ Включить в плеере'}
        </button>
        <button className="btn ghost" onClick={share}>
          {playlist.isPublic ? 'Ссылка' : 'Опубликовать'}
        </button>
      </div>

      {playlist.sourceChatId !== null && (
        <div className="notice">
          <div className="row">
            <div className="grow">
              <b>Плейлист связан с группой.</b>
              <div className="sub">
                {playlist.syncEnabled
                  ? 'Новые треки из группы дописываются сюда, переименование подхватывается.'
                  : 'Слежение выключено — плейлист живёт сам по себе.'}
              </div>
            </div>
            <button className="btn small ghost" onClick={toggleSync}>
              {playlist.syncEnabled ? 'Выключить' : 'Включить'}
            </button>
          </div>
          <div className="sub" style={{ marginTop: 8 }}>
            Историю группы бот прочитать не может — Telegram не даёт ботам доступ к прошлым
            сообщениям. Старое переносится пересылкой боту в личку.
          </div>
        </div>
      )}

      {me && !me.hasPlayerChat && (
        <div className="notice">Плеер не подключён — сначала создай группу и добавь туда бота админом.</div>
      )}

      {tracks.length > 0 && (
        <div className="hint">
          Треков — {tracks.length}. Выкладка занимает время: в одну группу Telegram пропускает
          примерно двадцать сообщений в минуту.
        </div>
      )}

      {tracks.length === 0 ? (
        <div className="empty">Пусто. Добавь треки из библиотеки.</div>
      ) : (
        tracks.map((track, index) => (
          <div className="card" key={track.id}>
            <div className="row">
              <button className="play" aria-label="Включить с этого трека" onClick={() => play(track.id)}>
                ▶
              </button>
              <span className="sub">{index + 1}</span>
              <div className="grow">
                <div className="title">{track.title ?? 'Без названия'}</div>
                <div className="sub">
                  {track.performer ?? 'Неизвестный исполнитель'} · {formatDuration(track.duration)}
                </div>
              </div>
              <button
                className="btn small danger"
                onClick={async () => {
                  await api.removeTrack(id, track.id);
                  reload();
                }}
              >
                Убрать
              </button>
            </div>
          </div>
        ))
      )}

      <div className="actions" style={{ marginTop: 16 }}>
        <button className="btn danger grow" onClick={remove}>
          Удалить плейлист
        </button>
      </div>
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

  if (error) {
    return (
      <div className="app">
        <div className="empty">{error}</div>
      </div>
    );
  }
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

function describe(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Не получилось';
}

function trackName(track: Track): string {
  return [track.performer, track.title].filter(Boolean).join(' — ') || 'Трек';
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
