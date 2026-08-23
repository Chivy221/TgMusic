import { readBotToken, readChannelId, readWebappUrl } from './env.js';

export const config = {
  botToken: readBotToken(),
  storageChannelId: readChannelId(),
  webappUrl: readWebappUrl(),
  port: Number(process.env.PORT ?? 8787),
  databasePath: process.env.DATABASE_PATH ?? './telemusic.db',

  /** Сколько треков кладём синхронно, до открытия ссылки. Остальное досылается фоном. */
  playbackHead: 5,
  /**
   * Пауза между фоновыми отправками. В одну группу бот может слать около двадцати
   * сообщений в минуту — отсюда чуть больше трёх секунд на трек.
   */
  playbackDelayMs: 3100,
};
