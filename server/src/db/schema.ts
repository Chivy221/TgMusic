import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';

/** Пользователь платформы. id — это telegram user id. */
export const users = sqliteTable('users', {
  id: integer('id').primaryKey(),
  username: text('username'),
  firstName: text('first_name'),
  /** Канал «Моя музыка», куда бот выкладывает плейлист для нативного плеера. */
  playbackChatId: integer('playback_chat_id'),
  createdAt: integer('created_at').notNull(),
});

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
    addedBy: integer('added_by').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ performerIdx: index('tracks_performer_idx').on(t.performer) }),
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
