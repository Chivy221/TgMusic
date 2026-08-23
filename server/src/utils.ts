import crypto from 'node:crypto';

/**
 * Ссылка на конкретное сообщение. Для приватного канала — t.me/c/<id без -100>/<message_id>.
 * Мини-апп открывает её через openTelegramLink, и Telegram встаёт ровно на первый трек.
 */
export function messageLink(chatId: number, messageId: number): string {
  const raw = String(chatId);
  const internal = raw.startsWith('-100') ? raw.slice(4) : raw.replace('-', '');
  return `https://t.me/c/${internal}/${messageId}`;
}

export function slug(length = 8): string {
  return crypto.randomBytes(16).toString('base64url').slice(0, length);
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
