import { readBotToken, readChannelId, readWebappUrl } from './env.js';

export const config = {
  botToken: readBotToken(),
  storageChannelId: readChannelId(),
  webappUrl: readWebappUrl(),
  port: Number(process.env.PORT ?? 8787),
  databasePath: process.env.DATABASE_PATH ?? './telemusic.db',

  /** Сколько треков кладём в канал синхронно, до открытия ссылки. Остальное досылается фоном. */
  playbackHead: 8,
  /** Пауза между фоновыми отправками: Telegram пропускает примерно сообщение в секунду в один чат. */
  playbackDelayMs: 1100,
};
