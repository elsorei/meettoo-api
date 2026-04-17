import { queryMany, queryOne } from '../../shared/db';

export interface ConflictingEvent {
  id: string;
  type: string;
  title: string;
  event_date: string;
  start_time: string;
  end_time: string;
  status: string;
}

export interface AvailabilityResult {
  available: boolean;
  conflicts: ConflictingEvent[];
  suggestion?: {
    date: string;
    startTime: string;
    endTime: string;
  };
}

/**
 * Check if a user is available for a given date/time range.
 * Looks for confirmed or pending appointments/commitments that overlap.
 */
export async function checkAvailability(
  userId: string,
  date: string,
  startTime: string,
  endTime: string,
  excludeEventId?: string
): Promise<AvailabilityResult> {
  const params: any[] = [userId, date, startTime, endTime];
  let excludeClause = '';

  if (excludeEventId) {
    excludeClause = 'AND e.id != $5';
    params.push(excludeEventId);
  }

  // Find overlapping events where this user is owner or participant
  const conflicts = await queryMany<ConflictingEvent>(
    `SELECT e.id, e.type, e.title, e.event_date::text,
            e.start_time::text, e.end_time::text, e.status
     FROM events e
     WHERE e.id IN (
       SELECT DISTINCT e2.id FROM events e2
       LEFT JOIN event_participants ep ON ep.event_id = e2.id
       WHERE (e2.owner_id = $1 OR ep.user_id = $1)
         AND e2.event_date = $2
         AND e2.start_time IS NOT NULL AND e2.end_time IS NOT NULL
         AND e2.start_time < $4 AND e2.end_time > $3
         AND e2.status IN ('pending', 'confirmed')
         AND e2.closed = false
         ${excludeClause}
     )
     ORDER BY e.start_time`,
    params
  );

  if (conflicts.length === 0) {
    return { available: true, conflicts: [] };
  }

  // Try to suggest an alternative time on the same day
  const suggestion = await findNextAvailableSlot(userId, date, startTime, endTime);

  return {
    available: false,
    conflicts,
    suggestion: suggestion || undefined,
  };
}

/**
 * Find the next available time slot for a user on a given date.
 * Returns null if no slot is available that day (within business hours 8:00-20:00).
 */
async function findNextAvailableSlot(
  userId: string,
  date: string,
  requestedStart: string,
  requestedEnd: string
): Promise<{ date: string; startTime: string; endTime: string } | null> {
  // Calculate duration in minutes
  const [rsh, rsm] = requestedStart.split(':').map(Number);
  const [reh, rem] = requestedEnd.split(':').map(Number);
  const durationMinutes = (reh * 60 + rem) - (rsh * 60 + rsm);

  if (durationMinutes <= 0) return null;

  // Get all occupied slots for this user on this date, ordered by start time
  const occupied = await queryMany<{ start_time: string; end_time: string }>(
    `SELECT e.start_time::text, e.end_time::text
     FROM events e
     WHERE e.id IN (
       SELECT DISTINCT e2.id FROM events e2
       LEFT JOIN event_participants ep ON ep.event_id = e2.id
       WHERE (e2.owner_id = $1 OR ep.user_id = $1)
         AND e2.event_date = $2
         AND e2.start_time IS NOT NULL AND e2.end_time IS NOT NULL
         AND e2.status IN ('pending', 'confirmed') AND e2.closed = false
     )
     ORDER BY e.start_time`,
    [userId, date]
  );

  // Business hours: 08:00 to 20:00
  const dayStart = 8 * 60;  // 480
  const dayEnd = 20 * 60;    // 1200

  // Build list of free gaps
  const slots: Array<{ start: number; end: number }> = [];
  let cursor = Math.max(dayStart, rsh * 60 + rsm); // start from requested time or day start

  for (const occ of occupied) {
    const [oh, om] = occ.start_time.split(':').map(Number);
    const [oeh, oem] = occ.end_time.split(':').map(Number);
    const occStart = oh * 60 + om;
    const occEnd = oeh * 60 + oem;

    if (cursor < occStart) {
      slots.push({ start: cursor, end: occStart });
    }
    cursor = Math.max(cursor, occEnd);
  }

  // Add remaining time until end of day
  if (cursor < dayEnd) {
    slots.push({ start: cursor, end: dayEnd });
  }

  // Find first slot that fits the duration
  for (const slot of slots) {
    if (slot.end - slot.start >= durationMinutes) {
      const startH = Math.floor(slot.start / 60);
      const startM = slot.start % 60;
      const endMinutes = slot.start + durationMinutes;
      const endH = Math.floor(endMinutes / 60);
      const endM = endMinutes % 60;

      return {
        date,
        startTime: `${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}`,
        endTime: `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`,
      };
    }
  }

  return null;
}

/**
 * Get a user's busy slots for a date range (for calendar overlay view).
 */
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
