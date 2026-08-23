import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  ApiError,
  api,
  type DownloadJob,
  type ImportResult,
  type KnownChat,
  type PlatformLink,
  type PlayResult,
  type Playlist,
  type Track,
  type VariantStatus,
} from './api';
import { alert, backButton, hasNativeBack, haptic, insideTelegram, sessionToken, sharedSlug, tg } from './telegram';

type View =
  | { name: 'library' }
  | { name: 'playlists' }
  | { name: 'playlist'; id: number }
  | { name: 'shared'; slug: string };

type Me = { hasPlayerChat: boolean; playerChatTitle: string | null };

/**
 * Кнопка «Назад» берётся у Telegram: показанная, она встаёт в шапке на место
 * крестика. Свою рисуем только вне Telegram, где шапки нет вовсе.
 *
 * Обработчик держим в ref: он меняется на каждый рендер, а подписку в Telegram
 * нужно снимать ровно тем же значением, которым её ставили.
 */
function useBackButton(handler?: () => void): void {
  const latest = useRef(handler);
  latest.current = handler;

  const active = Boolean(handler);

  useEffect(() => {
    const button = backButton;
    if (!active || !button) return;

    const onClick = () => latest.current?.();
    button.onClick(onClick);
    button.show();

    return () => {
      button.offClick(onClick);
      button.hide();
    };
  }, [active]);
}

/**
 * Экран второго уровня: заголовок, возврат и содержимое.
 * Пока он открыт, вкладки прячутся — иначе «назад» и переключение вкладок
 * спорят за один и тот же жест возврата.
 */
function Screen({
  title,
  onBack,
  onNested,
  children,
}: {
  title: ReactNode;
  onBack: () => void;
  onNested?: (open: boolean) => void;
  children: ReactNode;
}) {
  useBackButton(onBack);

  useEffect(() => {
    onNested?.(true);
    return () => onNested?.(false);
  }, [onNested]);

  return (
    <>
      <div className="header">
        {!hasNativeBack() && (
          <button className="back" onClick={onBack} aria-label="Назад">
            ‹
          </button>
        )}
        {typeof title === 'string' ? <div className="grow title">{title}</div> : title}
      </div>
      {children}
    </>
  );
}

export function App() {
  const slug = sharedSlug();
  const [view, setView] = useState<View>(slug ? { name: 'shared', slug } : { name: 'playlists' });
  const [me, setMe] = useState<Me | null>(null);
  const [nested, setNested] = useState(false);

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
      {!nested && (
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
      )}

      {view.name === 'playlists' ? (
        <PlaylistsView
          me={me}
          onNested={setNested}
          onOpen={(id) => setView({ name: 'playlist', id })}
        />
      ) : (
        <LibraryView me={me} onNested={setNested} onPlayerChange={reloadMe} />
      )}
    </div>
  );
}

/**
 * Выбор группы-плеера.
 *
 * Плеер — обычная группа Telegram, и групп у человека обычно несколько. Поэтому
 * это список с переключением, а не одна кнопка в переписке в момент добавления:
 * ту кнопку легко пролистать, и переиграть выбор потом было нечем.
 */
function PlayerPicker({ me, onChange }: { me: Me | null; onChange: () => void }) {
  const [chats, setChats] = useState<KnownChat[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const reload = useCallback(() => {
    api.chats()
      .then((data) => setChats(data.chats))
      .catch(() => setChats([]));
  }, []);

  useEffect(reload, [reload]);

  async function choose(chat: KnownChat) {
    if (chat.isPlayer) return;
    setBusy(true);
    try {
      await api.setPlayer(chat.id);
      haptic();
      reload();
      onChange();
      setOpen(false);
    } catch (error) {
      alert(describe(error));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api.disconnectPlayer();
      reload();
      onChange();
    } catch (error) {
      alert(describe(error));
    } finally {
      setBusy(false);
    }
  }

  async function clear() {
    setBusy(true);
    try {
      const { deleted } = await api.clearPlayer();
      alert(deleted > 0 ? `Убрано сообщений: ${deleted}` : 'В плеере и так пусто');
    } catch (error) {
      alert(describe(error));
    } finally {
      setBusy(false);
    }
  }

  const current = chats?.find((chat) => chat.isPlayer);

  return (
    <div className="notice">
      <div className="row">
        <div className="grow">
          <b>Плеер</b>
          <div className="sub">
            {current
              ? current.title
              : me?.hasPlayerChat
                ? (me.playerChatTitle ?? 'группа подключена')
                : 'не выбран'}
          </div>
        </div>
        <button className="btn small ghost" onClick={() => setOpen(!open)} disabled={busy}>
          {open ? 'Свернуть' : current ? 'Сменить' : 'Выбрать'}
        </button>
      </div>

      {current && !current.isAdmin && (
        <div className="sub warn">
          Я не администратор в этой группе — прошлый плейлист убрать не смогу, треки будут копиться.
        </div>
      )}

      {open && (
        <>
          {chats === null ? null : chats.length === 0 ? (
            <ol>
              <li>создай группу — она будет играть роль плеера</li>
              <li>добавь туда бота и выдай ему права администратора</li>
              <li>отключи в ней уведомления, иначе каждый трек будет пиликать</li>
            </ol>
          ) : (
            chats.map((chat) => (
              <div
                className="card pick"
                key={chat.id}
                data-active={chat.isPlayer}
                onClick={() => choose(chat)}
              >
                <div className="row">
                  <span className="sub">{chat.isPlayer ? '●' : '○'}</span>
                  <div className="grow">
                    <div className="title">{chat.title}</div>
                    <div className="sub">
                      {chat.type === 'channel' ? 'канал' : 'группа'}
                      {chat.isAdmin ? ' · админ' : ' · без прав администратора'}
                    </div>
                  </div>
                </div>
              </div>
            ))
          )}

          <div className="actions" style={{ marginTop: 10 }}>
            <button className="btn small ghost" onClick={reload} disabled={busy}>
              Обновить список
            </button>
            {current && (
              <>
                <button className="btn small ghost" onClick={clear} disabled={busy}>
                  Очистить
                </button>
                <button className="btn small danger" onClick={disconnect} disabled={busy}>
                  Отключить
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function PlaylistsView({
  me,
  onNested,
  onOpen,
}: {
  me: Me | null;
  onNested: (open: boolean) => void;
  onOpen: (id: number) => void;
}) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [title, setTitle] = useState('');
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState(false);

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

  if (importing) {
    return (
      <ImportView
        onNested={onNested}
        onBack={() => setImporting(false)}
        onDone={() => {
          setImporting(false);
          reload();
        }}
      />
    );
  }

  return (
    <>
      {!me?.hasPlayerChat && (
        <div className="notice">
          <b>Плеер не выбран.</b>
          <div className="sub">Играть пока негде — группа выбирается во вкладке «Библиотека».</div>
        </div>
      )}

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
        <button className="btn ghost grow" onClick={() => setImporting(true)}>
          ＋ По ссылке
        </button>
        <button className="btn ghost grow" onClick={merge}>
          🔀 Смешать все
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

function LibraryView({
  me,
  onNested,
  onPlayerChange,
}: {
  me: Me | null;
  onNested: (open: boolean) => void;
  onPlayerChange: () => void;
}) {
  const [tracks, setTracks] = useState<Track[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [picking, setPicking] = useState<Track | null>(null);
  const [editing, setEditing] = useState<Track | null>(null);
  const [importing, setImporting] = useState(false);

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
        onNested={onNested}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
    );
  }

  if (importing) {
    return (
      <ImportView
        onNested={onNested}
        onBack={() => setImporting(false)}
        onDone={() => {
          setImporting(false);
          reload();
        }}
      />
    );
  }

  if (picking) {
    return (
      <Screen title={trackName(picking)} onNested={onNested} onBack={() => setPicking(null)}>
        <div className="hint">В какой плейлист добавить?</div>
        {playlists.map((playlist) => (
          <div className="card" key={playlist.id} onClick={() => add(playlist.id)}>
            <div className="title">{playlist.title}</div>
          </div>
        ))}
      </Screen>
    );
  }

  return (
    <>
      <PlayerPicker me={me} onChange={onPlayerChange} />

      <div className="actions">
        <button className="btn ghost grow" onClick={() => setImporting(true)}>
          ＋ Добавить по ссылке
        </button>
      </div>

      {tracks.length === 0 ? (
        <div className="empty">Отправь боту любые аудиофайлы — они появятся здесь.</div>
      ) : (
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
          <div className="hint">Нажми на трек, чтобы переименовать или получить файл.</div>
        </>
      )}
    </>
  );
}

/**
 * Добавление по ссылке с другой площадки.
 *
 * Файлы там не забрать — площадки отдают только названия. Поэтому ссылка работает
 * как список: разбираем трек-лист и находим то, что уже есть в общем каталоге.
 * Ненайденное показываем целиком, чтобы было видно, чего именно не хватает.
 */
function ImportView({
  playlistId,
  onNested,
  onBack,
  onDone,
}: {
  playlistId?: number;
  onNested?: (open: boolean) => void;
  onBack: () => void;
  onDone: () => void;
}) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [job, setJob] = useState<DownloadJob | null>(null);

  /**
   * Загрузка идёт фоном на сервере и занимает минуты, поэтому состояние
   * опрашиваем. Останавливаемся, как только задача перестала быть running.
   */
  useEffect(() => {
    if (!job || job.state !== 'running') return;

    const timer = setInterval(() => {
      api.downloadJob(job.id)
        .then(({ job: fresh }) => setJob(fresh))
        .catch(() => undefined);
    }, 2500);

    return () => clearInterval(timer);
  }, [job]);

  async function run() {
    if (!url.trim()) return;
    setBusy(true);
    setJob(null);
    try {
      const found = await api.importLink(url.trim(), playlistId);
      setResult(found);
      haptic();
    } catch (error) {
      alert(describe(error));
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    setBusy(true);
    try {
      const { job: started } = await api.startDownload(url.trim(), playlistId);
      setJob(started);
      haptic();
    } catch (error) {
      alert(describe(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen title="Добавить по ссылке" onNested={onNested} onBack={onBack}>
      <div className="actions">
        <input
          className="input"
          placeholder="https://…"
          value={url}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && run()}
        />
        <button className="btn" onClick={run} disabled={busy || !url.trim()}>
          {busy ? '…' : 'Найти'}
        </button>
      </div>

      {result === null ? (
        <div className="notice">
          Ссылка на трек, альбом или плейлист.
          <ul>
            <li>Deezer, Apple Music, Spotify — альбом или плейлист целиком</li>
            <li>YouTube, SoundCloud — один трек по ссылке на него</li>
            <li>Яндекс Музыка — не отдаёт данные без токена аккаунта</li>
          </ul>
          <div className="sub">
            Сначала ищу треки из ссылки в общем каталоге — то, что уже залили сюда, добавляется
            мгновенно. Чего не найдётся, можно докачать с YouTube отдельной кнопкой: это дольше и
            качеством похуже, зато работает с чем угодно.
          </div>
        </div>
      ) : (
        <>
          <div className="card">
            <div className="title">{result.name}</div>
            <div className="sub">
              {result.source} ·{' '}
              {result.kind === 'track' ? 'трек' : result.kind === 'album' ? 'альбом' : 'плейлист'}
            </div>
          </div>

          <div className="hint">
            Добавлено: {result.found.length}
            {result.missing.length > 0 ? ` · не нашлось: ${result.missing.length}` : ''}
          </div>

          {result.partial && (
            <div className="notice">Эта площадка не отдаёт трек-лист без ключа — вышло только название.</div>
          )}

          {job === null && result.missing.length > 0 && (
            <div className="notice">
              {result.canDownload ? (
                <>
                  <div className="row">
                    <div className="grow">
                      <b>Скачать недостающее</b>
                      <div className="sub">
                        {result.missing.length} треков. Ищу каждый на YouTube и заливаю в фонотеку —
                        примерно полминуты на трек.
                      </div>
                    </div>
                  </div>
                  <div className="actions" style={{ marginTop: 10, marginBottom: 0 }}>
                    <button className="btn grow" onClick={download} disabled={busy}>
                      {busy ? 'Запускаю…' : `⬇ Скачать ${result.missing.length}`}
                    </button>
                  </div>
                </>
              ) : (
                <div className="sub">
                  Докачать не могу: на сервере нет yt-dlp. Эти треки появятся, когда их пришлют боту
                  файлом.
                </div>
              )}
            </div>
          )}

          {job !== null && <DownloadProgress job={job} />}

          {job === null &&
            result.missing.map((item, index) => (
              <div className="card" key={`${item.title}-${index}`}>
                <div className="title">{item.title}</div>
                <div className="sub">
                  {item.performer ?? 'Неизвестный исполнитель'} · нет в каталоге
                </div>
              </div>
            ))}

          <div className="actions" style={{ marginTop: 16 }}>
            <button className="btn grow" onClick={onDone} disabled={job?.state === 'running'}>
              {job?.state === 'running' ? 'Качаю…' : 'Готово'}
            </button>
            <button
              className="btn ghost"
              disabled={job?.state === 'running'}
              onClick={() => {
                setResult(null);
                setJob(null);
                setUrl('');
              }}
            >
              Ещё ссылка
            </button>
          </div>
        </>
      )}
    </Screen>
  );
}

/**
 * Ход загрузки. Показываем и скачанное, и сорвавшееся: у каждого трека своя
 * причина отказа, и «скачалось 7 из 12» без списка выглядит поломкой.
 */
function DownloadProgress({ job }: { job: DownloadJob }) {
  const downloaded = job.added.filter((item) => item.downloaded).length;

  return (
    <>
      <div className="notice">
        <b>
          {job.state === 'running'
            ? `Качаю: ${job.done} из ${job.total}`
            : job.state === 'failed'
              ? 'Загрузка сорвалась'
              : 'Готово'}
        </b>
        <div className="bar" aria-hidden>
          <div
            className="bar-fill"
            style={{ width: `${job.total === 0 ? 0 : Math.round((job.done / job.total) * 100)}%` }}
          />
        </div>
        <div className="sub">
          Скачано: {downloaded}
          {job.added.length > downloaded ? ` · нашлось в каталоге: ${job.added.length - downloaded}` : ''}
          {job.failed.length > 0 ? ` · не вышло: ${job.failed.length}` : ''}
        </div>
        {job.error && <div className="sub warn">{job.error}</div>}
        {job.state === 'running' && (
          <div className="sub" style={{ marginTop: 6 }}>
            Можно закрыть — загрузка идёт на сервере и не остановится.
          </div>
        )}
      </div>

      {job.failed.map((item, index) => (
        <div className="card" key={`failed-${index}`}>
          <div className="title">{item.title}</div>
          <div className="sub warn">
            {item.performer ?? 'Неизвестный исполнитель'} · {item.reason}
          </div>
        </div>
      ))}
    </>
  );
}

/** Переименование, файл и поиск на площадках — всё по одному треку. */
function TrackEditor({
  track,
  onNested,
  onClose,
  onSaved,
}: {
  track: Track;
  onNested: (open: boolean) => void;
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
      const { variant } = await api.renameTrack(track.id, { title, performer });
      haptic();

      const note = variantNote(variant);
      if (note) alert(note);

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
    <Screen title="Трек" onNested={onNested} onBack={onClose}>
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
        Пустые поля вернут исходное название из тегов. Чтобы имя поменялось и в самом плеере
        Telegram, я перезаливаю личную копию файла — это занимает пару секунд.
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
          {busy === 'links' ? 'Ищу…' : '🔎 Где послушать'}
        </button>
      </div>

      {links !== null && (
        <div className="hint">
          Этот же трек на других площадках — просто открыть и послушать там. В фонотеку ничего не
          добавляет.
        </div>
      )}

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
    </Screen>
  );
}

function PlaylistView({ id, me, onBack }: { id: number; me: Me | null; onBack: () => void }) {
  const [playlist, setPlaylist] = useState<Playlist | null>(null);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [busy, setBusy] = useState(false);
  const [renaming, setRenaming] = useState('');
  const [importing, setImporting] = useState(false);

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

  if (importing) {
    return (
      <div className="app">
        <ImportView
          playlistId={id}
          onBack={() => setImporting(false)}
          onDone={() => {
            setImporting(false);
            reload();
          }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <Screen
        onBack={onBack}
        title={
          <input
            className="input"
            value={renaming}
            onChange={(event) => setRenaming(event.target.value)}
            onBlur={rename}
            onKeyDown={(event) => event.key === 'Enter' && rename()}
          />
        }
      >
        <div className="actions">
          <button className="btn grow" onClick={() => play()} disabled={busy || tracks.length === 0}>
            {busy ? 'Выкладываю…' : '▶ Включить в плеере'}
          </button>
          <button className="btn ghost" onClick={share}>
            {playlist.isPublic ? 'Ссылка' : 'Опубликовать'}
          </button>
        </div>

        <div className="actions">
          <button className="btn ghost grow" onClick={() => setImporting(true)}>
            ＋ Добавить сюда по ссылке
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
          <div className="notice">
            Плеер не выбран — группа выбирается во вкладке «Библиотека».
          </div>
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
      </Screen>
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

/** Про перезаливку молчим, пока всё прошло гладко: это техника, а не событие. */
function variantNote(status: VariantStatus): string | null {
  if (status === 'too_big') {
    return 'Название сохранено, но в плеере останется старое: файл больше 20 МБ, а такие Telegram ботам скачивать не даёт — значит, и перезалить с новыми тегами нельзя.';
  }
  if (status === 'failed') {
    return 'Название сохранено, но перезалить файл не вышло — в плеере Telegram останутся старые теги.';
  }
  return null;
}

function trackName(track: Track): string {
  return [track.performer, track.title].filter(Boolean).join(' — ') || 'Трек';
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return '—';
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}
