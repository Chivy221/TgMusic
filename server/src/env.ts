import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

// .env лежит в корне монорепозитория, а npm workspaces запускают скрипты из server/,
// поэтому путь считаем от самого модуля, а не от cwd.
loadEnv({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

/** Настоящий токен выглядит как `<цифры>:<~35 символов>`. */
const TOKEN_SHAPE = /^\d{6,}:[A-Za-z0-9_-]{30,}$/;

export function readBotToken(): string {
  const value = process.env.BOT_TOKEN?.trim();

  if (!value) {
    throw new Error('В .env не задан BOT_TOKEN. Возьми токен у @BotFather.');
  }

  // Ловим самую частую ошибку: .env скопирован из .env.example и не отредактирован.
  if (!TOKEN_SHAPE.test(value)) {
    throw new Error(
      'BOT_TOKEN не похож на настоящий — видимо, в .env остался placeholder из .env.example.\n' +
        'Возьми токен у @BotFather (/mybots → API Token) и вставь его целиком.',
    );
  }

  return value;
}

export function readChannelId(): number {
  const raw = process.env.STORAGE_CHANNEL_ID?.trim();

  if (!raw) {
    throw new Error('В .env не задан STORAGE_CHANNEL_ID. Узнать id: npm run channel-id -w @telemusic/server');
  }

  if (raw === '-1001234567890') {
    throw new Error(
      'STORAGE_CHANNEL_ID остался примером из .env.example.\n' +
        'Узнать настоящий id: npm run channel-id -w @telemusic/server',
    );
  }

  const value = Number(raw);
  if (!Number.isInteger(value)) {
    throw new Error(`STORAGE_CHANNEL_ID должен быть числом вида -1001234567890, а не «${raw}»`);
  }

  return value;
}

export function readWebappUrl(): string {
  const value = process.env.WEBAPP_URL?.trim();

  if (!value) {
    throw new Error('В .env не задан WEBAPP_URL — публичный https-адрес мини-аппа.');
  }

  if (value.includes('example.trycloudflare.com')) {
    throw new Error(
      'WEBAPP_URL остался примером из .env.example.\n' +
        'Подними туннель: cloudflared tunnel --url http://localhost:5173',
    );
  }

  if (!value.startsWith('https://')) {
    throw new Error('WEBAPP_URL должен начинаться с https:// — Telegram открывает мини-аппы только по https.');
  }

  return value;
}
