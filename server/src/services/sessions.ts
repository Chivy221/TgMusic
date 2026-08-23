import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { now } from '../utils.js';

/**
 * Долгоживущий токен для PWA.
 *
 * Внутри Telegram личность подтверждает подпись initData на каждом запросе.
 * Вне Telegram её нет, поэтому мини-апп один раз обменивает подпись на токен,
 * а установленное на домашний экран приложение дальше ходит с ним.
 */
export function createSession(userId: number): string {
  const token = crypto.randomBytes(32).toString('base64url');
  const timestamp = now();

  db.insert(sessions).values({ token, userId, createdAt: timestamp, lastSeenAt: timestamp }).run();
  return token;
}

export function resolveSession(token: string): number | null {
  const session = db.select().from(sessions).where(eq(sessions.token, token)).get();
  if (!session) return null;

  // Пишем не чаще раза в сутки: иначе каждый запрос за треком дёргает диск.
  if (now() - session.lastSeenAt > 86_400) {
    db.update(sessions).set({ lastSeenAt: now() }).where(eq(sessions.token, token)).run();
  }

  return session.userId;
}

export function revokeSessions(userId: number): void {
  db.delete(sessions).where(eq(sessions.userId, userId)).run();
}
