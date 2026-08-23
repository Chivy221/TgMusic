import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { trackOverrides } from '../db/schema.js';
import type { Track } from './catalog.js';

/**
 * Личные названия поверх общего каталога.
 *
 * Переименовывать сам трек нельзя: он один на всех, кто его залил. Поэтому правки
 * хранятся отдельно и накладываются при чтении — у соседа останется как было.
 */
export function applyOverrides(userId: number, tracks: Track[]): Track[] {
  if (tracks.length === 0) return tracks;

  const rows = db
    .select()
    .from(trackOverrides)
    .where(
      and(
        eq(trackOverrides.userId, userId),
        inArray(
          trackOverrides.trackId,
          tracks.map((track) => track.id),
        ),
      ),
    )
    .all();

  if (rows.length === 0) return tracks;

  const byTrack = new Map(rows.map((row) => [row.trackId, row]));

  return tracks.map((track) => {
    const override = byTrack.get(track.id);
    if (!override) return track;

    return {
      ...track,
      title: override.title ?? track.title,
      performer: override.performer ?? track.performer,
    };
  });
}

export function applyOverride(userId: number, track: Track): Track {
  return applyOverrides(userId, [track])[0];
}

export function setOverride(
  userId: number,
  trackId: number,
  values: { title?: string | null; performer?: string | null },
): void {
  const title = normalize(values.title);
  const performer = normalize(values.performer);

  // Пустая правка — это возврат к каноническому названию, а не запись пустых строк.
  if (title === null && performer === null) {
    db.delete(trackOverrides)
      .where(and(eq(trackOverrides.userId, userId), eq(trackOverrides.trackId, trackId)))
      .run();
    return;
  }

  db.insert(trackOverrides)
    .values({ userId, trackId, title, performer })
    .onConflictDoUpdate({
      target: [trackOverrides.userId, trackOverrides.trackId],
      set: { title, performer },
    })
    .run();
}

function normalize(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 200) : null;
}
