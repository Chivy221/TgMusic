import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { config } from '../config.js';
import * as schema from './schema.js';

// На Railway база лежит на подключённом томе (например /data/telemusic.db) —
// каталог может не существовать при первом запуске.
mkdirSync(dirname(config.databasePath), { recursive: true });

const sqlite = new Database(config.databasePath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

/** Схема маленькая и стабильная — на MVP обходимся без drizzle-kit. */
export function migrate(): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT,
      first_name TEXT,
      playback_chat_id INTEGER,
      draft_playlist_id INTEGER,
      draft_stage TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS track_overrides (
      user_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      title TEXT,
      performer TEXT,
      PRIMARY KEY (user_id, track_id)
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_unique_id TEXT NOT NULL UNIQUE,
      file_id TEXT NOT NULL,
      storage_message_id INTEGER NOT NULL,
      title TEXT,
      performer TEXT,
      duration INTEGER,
      file_size INTEGER,
      added_by INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tracks_performer_idx ON tracks (performer);

    CREATE TABLE IF NOT EXISTS library (
      user_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      added_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, track_id)
    );

    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      is_public INTEGER NOT NULL DEFAULT 0,
      slug TEXT UNIQUE,
      source_playlist_id INTEGER,
      source_chat_id INTEGER,
      sync_enabled INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS playlists_owner_idx ON playlists (owner_id);

    CREATE TABLE IF NOT EXISTS playlist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL,
      track_id INTEGER NOT NULL,
      position INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS playlist_items_playlist_idx ON playlist_items (playlist_id);

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

    CREATE TABLE IF NOT EXISTS posted_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      chat_id INTEGER NOT NULL,
      message_id INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS posted_messages_user_idx ON posted_messages (user_id);
  `);

  // Базы, созданные до появления колонки, CREATE TABLE IF NOT EXISTS не чинит.
  addColumn('users', 'draft_playlist_id', 'INTEGER');
  addColumn('users', 'draft_stage', 'TEXT');
  addColumn('playlists', 'source_chat_id', 'INTEGER');
  addColumn('playlists', 'sync_enabled', 'INTEGER NOT NULL DEFAULT 0');
}

function addColumn(table: string, column: string, definition: string): void {
  const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) return;

  sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[db] добавлена колонка ${table}.${column}`);
}
