import { and, desc, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { chatMembers, chats, users } from '../db/schema.js';
import { bot } from '../bot/bot.js';
import { AppError, now } from '../utils.js';

export type KnownChat = {
  id: number;
  title: string;
  type: string;
  isAdmin: boolean;
  canDelete: boolean;
  isPlayer: boolean;
};

const PLAYABLE_TYPES = ['group', 'supergroup', 'channel'];

/** Статусы, при которых бот в чате уже не работает. */
const GONE = ['left', 'kicked'];

/**
 * Запоминаем чат при любом событии от него: список плееров в настройках должен
 * быть полным, а не собранным из тех кнопок, на которые человек успел нажать.
 */
export function rememberChat(
  chat: { id: number; type: string; title?: string },
  botStatus?: string,
  canDelete?: boolean,
): void {
  const values = {
    id: chat.id,
    title: chat.title ?? null,
    type: chat.type,
    botStatus: botStatus ?? null,
    botCanDelete: canDelete ? 1 : 0,
    updatedAt: now(),
  };

  db.insert(chats)
    .values(values)
    .onConflictDoUpdate({
      target: chats.id,
      // Статус пишем только когда он реально известен: обычное сообщение из чата
      // о правах бота ничего не говорит, и затирать ими прошлое знание нельзя.
      set: {
        title: values.title,
        type: values.type,
        updatedAt: values.updatedAt,
        ...(botStatus === undefined ? {} : { botStatus, botCanDelete: values.botCanDelete }),
      },
    })
    .run();
}

export function linkUserToChat(userId: number, chatId: number): void {
  db.insert(chatMembers)
    .values({ userId, chatId, addedAt: now() })
    .onConflictDoNothing()
    .run();
}

/** Чаты, куда этот пользователь добавлял бота и где бот всё ещё есть. */
export function listUserChats(userId: number): KnownChat[] {
  const user = db.select().from(users).where(eq(users.id, userId)).get();

  return db
    .select({ chat: chats })
    .from(chatMembers)
    .innerJoin(chats, eq(chats.id, chatMembers.chatId))
    .where(
      and(
        eq(chatMembers.userId, userId),
        inArray(chats.type, PLAYABLE_TYPES),
        // Статус известен не всегда: чат мог попасть в базу с обычного сообщения.
        // Сравнение с NULL в SQL даёт NULL, поэтому неизвестный статус проверяем явно —
        // иначе такие группы молча исчезают из списка.
        or(isNull(chats.botStatus), notInArray(chats.botStatus, GONE)),
      ),
    )
    .orderBy(desc(chats.updatedAt))
    .all()
    .map(({ chat }) => ({
      id: chat.id,
      title: chat.title ?? 'Без названия',
      type: chat.type ?? 'group',
      isAdmin: chat.botStatus === 'administrator',
      canDelete: chat.botCanDelete === 1,
      isPlayer: user?.playbackChatId === chat.id,
    }));
}

export function markChatGone(chatId: number, status: string): void {
  db.update(chats)
    .set({ botStatus: status, botCanDelete: 0, updatedAt: now() })
    .where(eq(chats.id, chatId))
    .run();
}

export function isGone(status: string | null): boolean {
  return status !== null && GONE.includes(status);
}

/**
 * HTTP-сервер поднимается раньше, чем бот успевает узнать о себе, и обращение
 * к botInfo в первые секунды после старта бросает исключение. Спрашиваем Telegram
 * напрямую, если так вышло.
 */
async function botId(): Promise<number> {
  try {
    return bot.botInfo.id;
  } catch {
    return (await bot.api.getMe()).id;
  }
}

/**
 * Перед выбором плеера спрашиваем Telegram заново: за время, прошедшее с добавления
 * бота, его могли разжаловать или выгнать, а пользователь — перестать быть админом.
 */
export async function verifyPlayerChat(userId: number, chatId: number): Promise<KnownChat> {
  let chat;
  try {
    chat = await bot.api.getChat(chatId);
  } catch {
    throw new AppError('chat_unreachable', 'Не получилось открыть группу — бот в ней ещё есть?');
  }

  // Плеер назначает только владелец или админ группы: иначе любой участник
  // мог бы привязать чужую группу к себе и заваливать её музыкой.
  const me = await bot.api.getChatMember(chatId, userId).catch(() => null);
  if (!me || (me.status !== 'creator' && me.status !== 'administrator')) {
    throw new AppError('not_chat_admin', 'Плеером можно сделать только группу, где ты администратор', 403);
  }

  const botMember = await bot.api.getChatMember(chatId, await botId()).catch(() => null);
  if (!botMember || isGone(botMember.status)) {
    throw new AppError('bot_not_in_chat', 'Бота нет в этой группе');
  }

  const canDelete = botMember.status === 'administrator' && Boolean(botMember.can_delete_messages);
  const title = 'title' in chat ? (chat.title ?? 'Без названия') : 'Без названия';

  rememberChat({ id: chatId, type: chat.type, title }, botMember.status, canDelete);
  linkUserToChat(userId, chatId);

  return {
    id: chatId,
    title,
    type: chat.type,
    isAdmin: botMember.status === 'administrator',
    canDelete,
    isPlayer: true,
  };
}

/**
 * Список для настроек.
 *
 * Действующий плеер добавляем отдельно: его могли выбрать кнопкой в переписке
 * ещё до появления этого списка, и строки о чате в базе тогда просто нет —
 * а показать «плеер не выбран» человеку, у которого он выбран, хуже всего.
 */
export async function listPlayableChats(userId: number): Promise<KnownChat[]> {
  const known = listUserChats(userId);
  const playerId = db.select().from(users).where(eq(users.id, userId)).get()?.playbackChatId;

  if (!playerId || known.some((chat) => chat.id === playerId)) return known;

  try {
    const chat = await bot.api.getChat(playerId);
    const member = await bot.api.getChatMember(playerId, await botId());
    const title = 'title' in chat ? (chat.title ?? 'Без названия') : 'Без названия';
    const canDelete = member.status === 'administrator' && Boolean(member.can_delete_messages);

    rememberChat({ id: playerId, type: chat.type, title }, member.status, canDelete);
    linkUserToChat(userId, playerId);

    return [
      {
        id: playerId,
        title,
        type: chat.type,
        isAdmin: member.status === 'administrator',
        canDelete,
        isPlayer: true,
      },
      ...known,
    ];
  } catch {
    return known;
  }
}
