import { queryMany } from '../../shared/db';
import { eventsToFreeBitmap, scanFreeWindows, isFree, SLOT_MINUTES } from './availability-engine';
import type { RawEvent, FreeSlot } from './availability-engine';

export interface AvailabilityResult {
  available: boolean;
  suggestion?: FreeSlot;
}

const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES;

function toMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Disponibilità di un singolo utente in una finestra oraria, sul motore
 * bitmap. Se occupato, propone la prima finestra libera della giornata
 * (preferendo un orario successivo a quello richiesto).
 */
export async function checkAvailability(
  userId: string,
  date: string,
  startTime: string,
  endTime: string,
  excludeEventId?: string
): Promise<AvailabilityResult> {
  const params: any[] = [userId, date];
  let excludeClause = '';
  if (excludeEventId) {
    excludeClause = 'AND e.id <> $3';
    params.push(excludeEventId);
  }

  const events = await queryMany<RawEvent>(
    `SELECT e.event_date::text, e.start_time::text, e.end_time::text,
            e.recurrence_rule, e.recurrence_exceptions
     FROM events e
     JOIN event_participants ep ON ep.event_id = e.id
     WHERE ep.user_id = $1
       AND e.start_time IS NOT NULL AND e.end_time IS NOT NULL
       AND e.status IN ('pending', 'confirmed') AND e.closed = false
       AND (
         (e.recurrence_rule IS NULL AND e.event_date = $2)
         OR (e.recurrence_rule IS NOT NULL AND e.event_date <= $2)
       )
       ${excludeClause}`,
    params
  );

  const bitmap = eventsToFreeBitmap(events, date, date);
  const startSlot = Math.floor(toMinutes(startTime) / SLOT_MINUTES);
  const endSlot = Math.ceil(toMinutes(endTime) / SLOT_MINUTES) - 1;

  for (let i = startSlot; i <= endSlot; i++) {
    if (!isFree(bitmap, i)) {
      const duration = toMinutes(endTime) - toMinutes(startTime);
      const windows = scanFreeWindows(bitmap, date, SLOTS_PER_DAY, duration, 20);
      return {
        available: false,
        suggestion: windows.find((w) => w.startTime >= startTime) || windows[0],
      };
    }
  }
  return { available: true };
}

/** Slot occupati di un utente in un intervallo (per la vista calendario). */
export async function getBusySlots(
  userId: string,
  fromDate: string,
  toDate: string
): Promise<Array<{ date: string; startTime: string; endTime: string; type: string }>> {
  return queryMany(
    `SELECT e.event_date::text AS date,
            e.start_time::text AS "startTime",
            e.end_time::text AS "endTime",
            e.type
     FROM events e
     WHERE e.id IN (
       SELECT DISTINCT e2.id FROM events e2
       LEFT JOIN event_participants ep ON ep.event_id = e2.id
       WHERE (e2.owner_id = $1 OR ep.user_id = $1)
         AND e2.event_date >= $2 AND e2.event_date <= $3
         AND e2.start_time IS NOT NULL
         AND e2.status IN ('pending', 'confirmed') AND e2.closed = false
     )
     ORDER BY e.event_date, e.start_time`,
    [userId, fromDate, toDate]
  );
}
