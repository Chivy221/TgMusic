import crypto from 'node:crypto';
import { createMiddleware } from 'hono/factory';
import { config } from '../config.js';
import { ensureUser } from '../services/catalog.js';
import { resolveSession } from '../services/sessions.js';

export type Env = { Variables: { userId: number } };

export type TelegramUser = {
  id: number;
  username?: string;
  first_name?: string;
};

const MAX_AGE_SECONDS = 24 * 60 * 60;

/**
 * Проверка initData мини-аппа.
 * Ключ — HMAC('WebAppData', botToken), подпись считается по всем полям кроме hash,
 * отсортированным по имени. Единственное доказательство, что запрос пришёл от Telegram.
 */
export function verifyInitData(initData: string): TelegramUser | null {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const expected = Buffer.from(hash, 'hex');
  const actual = Buffer.from(computed, 'hex');
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;

  const authDate = Number(params.get('auth_date'));
  if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) return null;

  const raw = params.get('user');
  if (!raw) return null;

  try {
    return JSON.parse(raw) as TelegramUser;
  } catch {
    return null;
  }
}

/**
 * Два пути входа:
 *  tma <initData>  — мини-апп внутри Telegram, подпись проверяется на каждом запросе;
 *  Bearer <token>  — установленное PWA, где initData недоступен.
 */
export const auth = createMiddleware<Env>(async (c, next) => {
  const header = c.req.header('Authorization') ?? '';

  if (header.startsWith('tma ')) {
    const user = verifyInitData(header.slice(4));
    if (!user) return c.json({ error: 'unauthorized' }, 401);

    ensureUser(user.id, user.username, user.first_name);
    c.set('userId', user.id);
    return next();
  }

  if (header.startsWith('Bearer ')) {
    const userId = resolveSession(header.slice(7));
    if (userId === null) return c.json({ error: 'unauthorized' }, 401);

    c.set('userId', userId);
    return next();
  }

  return c.json({ error: 'unauthorized' }, 401);
});
