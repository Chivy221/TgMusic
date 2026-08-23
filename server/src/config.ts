import { readBotToken, readChannelId, readWebappUrl } from './env.js';

export const config = {
  botToken: readBotToken(),
  storageChannelId: readChannelId(),
  webappUrl: readWebappUrl(),
  port: Number(process.env.PORT ?? 8787),
  databasePath: process.env.DATABASE_PATH ?? './telemusic.db',

  /**
   * Загрузка по ссылке через yt-dlp. Единственное место, где аудиобайты идут
   * через наш сервер, — отсюда лимиты: без них один длинный микс занимает диск,
   * процессор и слот загрузки на всё время скачивания.
   */
  ytdlpPath: process.env.YTDLP_PATH ?? 'yt-dlp',
  downloadMaxMb: Number(process.env.DOWNLOAD_MAX_MB ?? 45),
  downloadMaxSeconds: Number(process.env.DOWNLOAD_MAX_SECONDS ?? 1800),
  downloadTimeoutMs: Number(process.env.DOWNLOAD_TIMEOUT_MS ?? 240_000),
  /** Потолок на один запрос: плейлист на тысячу треков качать никто не будет ждать. */
  downloadMaxItems: Number(process.env.DOWNLOAD_MAX_ITEMS ?? 50),
  /** Боты заливают в Telegram файлы до 50 МБ. */
  uploadMaxMb: 50,

  /** Сколько треков кладём синхронно, до открытия ссылки. Остальное досылается фоном. */
  playbackHead: 5,
  /**
   * Пауза между фоновыми отправками. В одну группу бот может слать около двадцати
   * сообщений в минуту — отсюда чуть больше трёх секунд на трек.
   */
  playbackDelayMs: 3100,
};
