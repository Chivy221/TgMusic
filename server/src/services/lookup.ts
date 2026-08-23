import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

export function getUserByPlaybackChat(chatId: number) {
  return db.select().from(users).where(eq(users.playbackChatId, chatId)).get();
}
