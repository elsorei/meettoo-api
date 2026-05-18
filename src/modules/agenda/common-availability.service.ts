import * as engine from './availability-engine';

interface TimeSlot {
  date: string;
  startTime: string;
  endTime: string;
}

/** Aggiunge n giorni a una data YYYY-MM-DD. */
function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Primo slot comune libero per TUTTI gli utenti, di durata durationMinutes,
 * a partire da fromDate. Delega al motore bitmap (intersezione delle agende).
 */
export async function findCommonSlot(
  userIds: string[],
  fromDate: string,
  durationMinutes: number,
  maxDaysToSearch = 14
): Promise<TimeSlot | null> {
  if (userIds.length === 0) return null;
  const toDate = addDays(fromDate, Math.max(0, maxDaysToSearch - 1));
  const slots = await engine.findCommonSlots(userIds, fromDate, toDate, durationMinutes, 1);
  return slots[0] || null;
}

/**
 * Per ciascun utente, indica se è libero nella finestra richiesta.
 * Delega al motore bitmap.
 */
export async function checkMultiAvailability(
  userIds: string[],
  date: string,
  startTime: string,
  endTime: string
): Promise<Array<{ userId: string; available: boolean }>> {
  const res = await engine.usersFreeAt(userIds, date, startTime, endTime);
  return res.map((r) => ({ userId: r.userId, available: r.free }));
}
