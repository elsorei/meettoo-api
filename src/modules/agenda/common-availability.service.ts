import { queryMany } from '../../shared/db';

interface TimeSlot {
  date: string;
  startTime: string;
  endTime: string;
}

/**
 * Find the first available common time slot for ALL given operators.
 * Searches from a start date, checking business hours (08:00-19:00) for a given duration.
 * Returns the first slot where ALL operators are free.
 */
export async function findCommonSlot(
  userIds: string[],
  fromDate: string,
  durationMinutes: number,
  maxDaysToSearch: number = 14
): Promise<TimeSlot | null> {
  if (userIds.length === 0) return null;

  const startDate = new Date(fromDate);
  const businessStart = 8 * 60; // 08:00 in minutes
  const businessEnd = 19 * 60;  // 19:00 in minutes

  for (let dayOffset = 0; dayOffset < maxDaysToSearch; dayOffset++) {
    const checkDate = new Date(startDate);
    checkDate.setDate(checkDate.getDate() + dayOffset);

    // Skip weekends
    const dow = checkDate.getDay();
    if (dow === 0 || dow === 6) continue;

    const dateStr = checkDate.toISOString().split('T')[0];

    // Get all occupied slots for ALL users on this date
    const occupied = await queryMany<{ user_id: string; start_time: string; end_time: string }>(
      `SELECT ep.user_id, e.start_time::text, e.end_time::text
       FROM events e
       JOIN event_participants ep ON ep.event_id = e.id
       WHERE ep.user_id = ANY($1)
         AND e.event_date = $2
         AND e.start_time IS NOT NULL AND e.end_time IS NOT NULL
         AND e.status IN ('pending', 'confirmed')
         AND e.closed = false
       ORDER BY e.start_time`,
      [userIds, dateStr]
    );

    // Build busy intervals per user
    const busyByUser = new Map<string, Array<{ start: number; end: number }>>();
    for (const uid of userIds) busyByUser.set(uid, []);

    for (const occ of occupied) {
      const [sh, sm] = occ.start_time.split(':').map(Number);
      const [eh, em] = occ.end_time.split(':').map(Number);
      busyByUser.get(occ.user_id)?.push({ start: sh * 60 + sm, end: eh * 60 + em });
    }

    // Scan time slots in 30-minute increments
    for (let slotStart = businessStart; slotStart + durationMinutes <= businessEnd; slotStart += 30) {
      const slotEnd = slotStart + durationMinutes;

      // Check if ALL users are free in this slot
      let allFree = true;
      for (const uid of userIds) {
        const busy = busyByUser.get(uid) || [];
        const hasConflict = busy.some(b => b.start < slotEnd && b.end > slotStart);
        if (hasConflict) { allFree = false; break; }
      }

      if (allFree) {
        const startH = Math.floor(slotStart / 60);
        const startM = slotStart % 60;
        const endH = Math.floor(slotEnd / 60);
        const endM = slotEnd % 60;
        return {
          date: dateStr,
          startTime: `${String(startH).padStart(2, '0')}:${String(startM).padStart(2, '0')}`,
          endTime: `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`,
        };
      }
    }
  }

  return null; // No common slot found in the search range
}

/**
 * Check availability of multiple users at a specific date/time.
 * Returns per-user availability with conflict details.
 */
export async function checkMultiAvailability(
  userIds: string[],
  date: string,
  startTime: string,
  endTime: string
): Promise<Array<{ userId: string; available: boolean; conflictTitle?: string; conflictTime?: string }>> {
  const results: Array<{ userId: string; available: boolean; conflictTitle?: string; conflictTime?: string }> = [];

  for (const uid of userIds) {
    const conflict = await queryMany<{ title: string; start_time: string; end_time: string }>(
      `SELECT e.title, e.start_time::text, e.end_time::text
       FROM events e
       JOIN event_participants ep ON ep.event_id = e.id
       WHERE ep.user_id = $1 AND e.event_date = $2
         AND e.start_time < $4 AND e.end_time > $3
         AND e.status IN ('pending', 'confirmed') AND e.closed = false
       LIMIT 1`,
      [uid, date, startTime, endTime]
    );

    if (conflict.length > 0) {
      results.push({
        userId: uid,
        available: false,
        conflictTitle: conflict[0].title,
        conflictTime: `${conflict[0].start_time.substring(0, 5)}-${conflict[0].end_time.substring(0, 5)}`,
      });
    } else {
      results.push({ userId: uid, available: true });
    }
  }

  return results;
}
