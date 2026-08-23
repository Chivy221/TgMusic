import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

/** Пользователь платформы. id — это telegram user id. */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  username: text('username'),
  firstName: text('first_name'),
  /**
   * Куда бот выкладывает плейлист. Если пусто — прямо в личку с ботом.
   * Канал надёжнее: в личке свои сообщения удаляются только первые 48 часов.
   */
  playbackChatId: integer('playback_chat_id'),
  /** Сбор плейлиста через бота: /new → название → треки → /done. */
  draftPlaylistId: integer('draft_playlist_id'),
  draftStage: text('draft_stage', { enum: ['awaiting_title', 'collecting'] }),
  createdAt: integer('created_at').notNull(),
});

/**
 * Личные правки названия и исполнителя.
 *
 * Сам трек в каталоге общий — он дедуплицируется по file_unique_id и может быть
 * в фонотеках у тысячи людей. Поэтому переименование не трогает канонический
 * трек, а живёт отдельной записью на пользователя.
 */
export const trackOverrides = sqliteTable(
  'track_overrides',
  {
    userId: integer('user_id').notNull(),
    trackId: integer('track_id').notNull(),
    title: text('title'),
    performer: text('performer'),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.trackId] }) }),
);

/**
 * Канонический трек в канале-хранилище.
 * Файл лежит на серверах Telegram, у нас только ссылки — байты мы не трогаем никогда.
 */
export const tracks = sqliteTable(
  'tracks',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Одинаков для одного файла у всех ботов — на нём и строится дедуп. */
    fileUniqueId: text('file_unique_id').notNull().unique(),
    /** Привязан к нашему боту. Если бот сменится, восстанавливаем из storage_message_id. */
    fileId: text('file_id').notNull(),
    storageMessageId: integer('storage_message_id').notNull(),
    title: text('title'),
    performer: text('performer'),
    duration: integer('duration'),
    fileSize: integer('file_size'),
    /**
     * Откуда скачан, если трек приехал по ссылке: `youtube:dQw4w9WgXcQ`.
     * Дедуп по file_unique_id тут не работает — каждая загрузка даёт свои байты,
     * поэтому одинаковость определяем по источнику.
     */
    sourceKey: text('source_key'),
    addedBy: integer('added_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    performerIdx: index('tracks_performer_idx').on(t.performer),
    sourceIdx: index('tracks_source_idx').on(t.sourceKey),
  }),
);

/** Личная фонотека: какие треки пользователь считает своими. */
export const library = sqliteTable(
  'library',
  {
    userId: integer('user_id').notNull(),
    trackId: integer('track_id').notNull(),
    addedAt: integer('added_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.trackId] }) }),
);

export const playlists = sqliteTable(
  'playlists',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ownerId: integer('owner_id').notNull(),
    title: text('title').notNull(),
    isPublic: integer('is_public').notNull().default(0),
    /** Короткий код для deep link t.me/<bot>/app?startapp=<slug>. */
    slug: text('slug').unique(),
    /** Откуда склонирован, если это чужой добавленный плейлист. */
    sourcePlaylistId: integer('source_playlist_id'),
    /** Группа-источник: всё аудио оттуда дописывается в этот плейлист. */
    sourceChatId: integer('source_chat_id'),
    /** Следить за группой: новые треки дописывать, переименование подхватывать. */
    syncEnabled: integer('sync_enabled').notNull().default(0),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ ownerIdx: index('playlists_owner_idx').on(t.ownerId) }),
);

export const playlistItems = sqliteTable(
  'playlist_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    playlistId: integer('playlist_id').notNull(),
    trackId: integer('track_id').notNull(),
    position: integer('position').notNull(),
  },
  (t) => ({ playlistIdx: index('playlist_items_playlist_idx').on(t.playlistId) }),
);

/**
 * Сессия для PWA: вне Telegram нет initData, а фон на iOS работает только там.
 * Токен выдаётся из мини-аппа, где личность уже подтверждена подписью.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    token: text('token').primaryKey(),
    userId: integer('user_id').notNull(),
    createdAt: integer('created_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (t) => ({ userIdx: index('sessions_user_idx').on(t.userId) }),
);

/** Что бот уже выложил в канал пользователя — чтобы вычистить при смене плейлиста. */
export const postedMessages = sqliteTable(
  'posted_messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    chatId: integer('chat_id').notNull(),
    messageId: integer('message_id').notNull(),
  },
  (t) => ({ userIdx: index('posted_messages_user_idx').on(t.userId) }),
);

/**
 * Чаты, в которых бот оказался вместе с пользователем.
 *
 * Нужны, чтобы плеер выбирался списком в настройках, а не единственной кнопкой
 * в переписке в момент добавления: кнопку легко пролистать, а группа у человека
 * не одна. Права проверяются заново при выборе — статус мог измениться.
 */
export const chats = sqliteTable('chats', {
  id: integer('id').primaryKey(),
  title: text('title'),
  type: text('type'),
  /** Статус бота: administrator / member / left / kicked. */
  botStatus: text('bot_status'),
  botCanDelete: integer('bot_can_delete').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

/** Кто из пользователей видел этот чат — чужие группы в списке не показываем. */
export const chatMembers = sqliteTable(
  'chat_members',
  {
    userId: integer('user_id').notNull(),
    chatId: integer('chat_id').notNull(),
    addedAt: integer('added_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.chatId] }) }),
);

/**
 * Личная перезалитая копия трека.
 *
 * Telegram берёт название и исполнителя из атрибутов сохранённого файла: при
 * отправке по file_id переданные title и performer игнорируются. Поэтому правка
 * имени видна в Telegram только у нового файла — заливаем копию с нужными тегами
 * и дальше шлём её вместо оригинала. Оригинал в каталоге не трогаем: он общий.
 */
export const trackVariants = sqliteTable(
  'track_variants',
  {
    userId: integer('user_id').notNull(),
    trackId: integer('track_id').notNull(),
    fileId: text('file_id').notNull(),
    fileUniqueId: text('file_unique_id').notNull(),
    storageMessageId: integer('storage_message_id').notNull(),
    /** С какими тегами залито — чтобы понять, не устарела ли копия. */
    title: text('title'),
    performer: text('performer'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.trackId] }) }),
);
