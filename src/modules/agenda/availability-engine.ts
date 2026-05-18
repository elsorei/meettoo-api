import { queryMany } from '../../shared/db';
import { getRedis } from '../../config/redis';
import { RRule } from 'rrule';
import type { RedisClientType } from 'redis';

/**
 * Motore di disponibilità a bitmap ("scolapasta").
 *
 * L'agenda di un utente, su un intervallo di date, è una bitmap: un bit per
 * ogni slot di SLOT_MINUTES minuti. bit = 1 -> slot LIBERO (il "buco" dello
 * scolapasta), bit = 0 -> occupato. L'AND di più bitmap dà gli slot liberi
 * per tutti; la somma per-slot dà quanti utenti sono liberi.
 *
 * I bit sono impacchettati MSB-first, la stessa convenzione dei bitmap di
 * Redis (SETBIT/BITOP): il Buffer prodotto qui è byte-identico a quello che
 * la cache salverà su Redis, così l'AND lato cache (BITOP AND) e l'AND qui
 * danno lo stesso risultato.
 */

export const SLOT_MINUTES = 15;
const SLOTS_PER_DAY = (24 * 60) / SLOT_MINUTES; // 96

export interface RawEvent {
  event_date: string;
  start_time: string;
  end_time: string;
  recurrence_rule: string | null;
  recurrence_exceptions: string[] | null;
}

export interface FreeSlot {
  date: string;
  startTime: string;
  endTime: string;
}

// ── date / slot ──

function parseDate(d: string): Date {
  return new Date(`${d}T00:00:00Z`);
}

function dateToStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Giorni inclusi nell'intervallo [fromDate, toDate]. */
export function rangeDays(fromDate: string, toDate: string): number {
  const ms = parseDate(toDate).getTime() - parseDate(fromDate).getTime();
  return Math.floor(ms / 86400000) + 1;
}

function dayOffset(fromDate: string, date: string): number {
  const ms = parseDate(date).getTime() - parseDate(fromDate).getTime();
  return Math.floor(ms / 86400000);
}

function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

function minutesToTime(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

// ── bit (impacchettati MSB-first, bit = 1 -> libero) ──

function bitMask(i: number): number {
  return 1 << (7 - (i & 7));
}

function getBit(buf: Buffer, i: number): boolean {
  return (buf[i >> 3] & bitMask(i)) !== 0;
}

function clearBit(buf: Buffer, i: number): void {
  buf[i >> 3] &= ~bitMask(i) & 0xff;
}

/** Lo slot `i` della bitmap è libero? */
export function isFree(bitmap: Buffer, i: number): boolean {
  return getBit(bitmap, i);
}

// ── costruzione bitmap dagli eventi (puro, testabile senza DB) ──

/**
 * Bitmap dei liberi di un utente dati i suoi eventi con orario,
 * sull'intervallo [fromDate, toDate]. Espande gli eventi ricorrenti.
 */
export function eventsToFreeBitmap(events: RawEvent[], fromDate: string, toDate: string): Buffer {
  const days = rangeDays(fromDate, toDate);
  const numSlots = days * SLOTS_PER_DAY;
  const buf = Buffer.alloc(Math.ceil(numSlots / 8), 0xff); // tutto libero

  for (const ev of events) {
    if (!ev.start_time || !ev.end_time) continue;
    const startMin = timeToMinutes(ev.start_time);
    const endMin = timeToMinutes(ev.end_time);
    if (endMin <= startMin) continue;

    const occDates = ev.recurrence_rule
      ? expandRecurrence(ev, fromDate, toDate)
      : [ev.event_date];

    for (const occDate of occDates) {
      const off = dayOffset(fromDate, occDate);
      if (off < 0 || off >= days) continue;
      const base = off * SLOTS_PER_DAY;
      const first = base + Math.floor(startMin / SLOT_MINUTES);
      const last = Math.min(
        base + SLOTS_PER_DAY - 1,
        base + Math.ceil(endMin / SLOT_MINUTES) - 1
      );
      for (let i = first; i <= last; i++) clearBit(buf, i);
    }
  }
  return buf;
}

function expandRecurrence(ev: RawEvent, fromDate: string, toDate: string): string[] {
  try {
    const [hh, mm] = ev.start_time.split(':');
    const dtstart = `DTSTART:${ev.event_date.replace(/-/g, '')}T${hh.padStart(2, '0')}${mm.padStart(2, '0')}00\n`;
    const rule = RRule.fromString(`${dtstart}RRULE:${ev.recurrence_rule}`);
    const exceptions = ev.recurrence_exceptions || [];
    return rule
      .between(new Date(`${fromDate}T00:00:00`), new Date(`${toDate}T23:59:59`), true)
      .map((d) => d.toISOString().slice(0, 10))
      .filter((d) => !exceptions.includes(d));
  } catch {
    return [ev.event_date];
  }
}

// ── costruzione dal database ──

/** Bitmap dei liberi per più utenti leggendo direttamente dal database. */
async function buildFreeBitmapsFromDb(
  userIds: string[],
  fromDate: string,
  toDate: string
): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  if (userIds.length === 0) return result;

  const rows = await queryMany<RawEvent & { user_id: string }>(
    `SELECT ep.user_id, e.event_date::text, e.start_time::text, e.end_time::text,
            e.recurrence_rule, e.recurrence_exceptions
     FROM events e
     JOIN event_participants ep ON ep.event_id = e.id
     WHERE ep.user_id = ANY($1)
       AND e.start_time IS NOT NULL AND e.end_time IS NOT NULL
       AND e.status IN ('pending', 'confirmed') AND e.closed = false
       AND (
         (e.recurrence_rule IS NULL AND e.event_date >= $2 AND e.event_date <= $3)
         OR (e.recurrence_rule IS NOT NULL AND e.event_date <= $3)
       )`,
    [userIds, fromDate, toDate]
  );

  const byUser = new Map<string, RawEvent[]>();
  for (const uid of userIds) byUser.set(uid, []);
  for (const r of rows) byUser.get(r.user_id)?.push(r);
  for (const uid of userIds) {
    result.set(uid, eventsToFreeBitmap(byUser.get(uid)!, fromDate, toDate));
  }
  return result;
}

// ── cache Redis ──
//
// Per ogni utente teniamo in Redis la bitmap dei liberi su un orizzonte fisso
// di HORIZON_DAYS giorni a partire da oggi (chiave avail:{userId}:{oggi}).
// Una richiesta su un sotto-intervallo affetta la bitmap dell'orizzonte: ogni
// giorno occupa 12 byte esatti, quindi il taglio è allineato ai byte.
// La cache degrada con grazia: se Redis non risponde si calcola dal database.

const HORIZON_DAYS = 90;
const BYTES_PER_DAY = SLOTS_PER_DAY / 8; // 12
const CACHE_TTL_S = 36 * 3600;

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(date: string, n: number): string {
  const d = parseDate(date);
  d.setUTCDate(d.getUTCDate() + n);
  return dateToStr(d);
}

async function safeGetRedis(): Promise<RedisClientType | null> {
  try {
    return await getRedis();
  } catch {
    return null;
  }
}

/**
 * Bitmap dei liberi per più utenti su [fromDate, toDate]. Stessa firma di
 * sempre: la cache Redis è "infilata dietro" senza cambiare l'interfaccia.
 */
export async function buildFreeBitmaps(
  userIds: string[],
  fromDate: string,
  toDate: string
): Promise<Map<string, Buffer>> {
  if (userIds.length === 0) return new Map();

  const anchor = todayUTC();
  const horizonEnd = addDays(anchor, HORIZON_DAYS - 1);

  // Intervallo fuori dall'orizzonte della cache: calcolo diretto dal database.
  if (fromDate < anchor || toDate > horizonEnd) {
    return buildFreeBitmapsFromDb(userIds, fromDate, toDate);
  }

  const redis = await safeGetRedis();
  const horizons = new Map<string, Buffer>();
  const missed: string[] = [];

  if (redis) {
    for (const uid of userIds) {
      let buf: Buffer | null = null;
      try {
        const cached = await redis.get(`avail:${uid}:${anchor}`);
        if (cached) buf = Buffer.from(cached, 'base64');
      } catch {
        buf = null;
      }
      if (buf) horizons.set(uid, buf);
      else missed.push(uid);
    }
  } else {
    missed.push(...userIds);
  }

  if (missed.length > 0) {
    const computed = await buildFreeBitmapsFromDb(missed, anchor, horizonEnd);
    for (const uid of missed) {
      const buf = computed.get(uid)!;
      horizons.set(uid, buf);
      if (redis) {
        try {
          await redis.set(`avail:${uid}:${anchor}`, buf.toString('base64'), { EX: CACHE_TTL_S });
        } catch {
          /* best effort */
        }
      }
    }
  }

  // Taglia ogni orizzonte sul sotto-intervallo richiesto (taglio ai byte).
  const startByte = dayOffset(anchor, fromDate) * BYTES_PER_DAY;
  const endByte = (dayOffset(anchor, toDate) + 1) * BYTES_PER_DAY;
  const result = new Map<string, Buffer>();
  for (const uid of userIds) {
    result.set(uid, Buffer.from(horizons.get(uid)!.subarray(startByte, endByte)));
  }
  return result;
}

/** Invalida la cache disponibilità di una lista di utenti. Best effort. */
export async function invalidateUsers(userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  try {
    const redis = await safeGetRedis();
    if (!redis) return;
    const anchor = todayUTC();
    await Promise.all(userIds.map((uid) => redis.del(`avail:${uid}:${anchor}`)));
  } catch {
    /* best effort */
  }
}

/**
 * Invalida la cache di tutti i partecipanti di un evento, più eventuali utenti
 * extra (es. un partecipante appena rimosso). Best effort: non solleva errori.
 */
export async function invalidateEvent(eventId: string, extraUserIds: string[] = []): Promise<void> {
  try {
    const rows = await queryMany<{ user_id: string }>(
      `SELECT user_id FROM event_participants WHERE event_id = $1`,
      [eventId]
    );
    const ids = new Set<string>(extraUserIds);
    for (const r of rows) ids.add(r.user_id);
    await invalidateUsers([...ids]);
  } catch {
    /* best effort */
  }
}

// ── operazioni sulle bitmap ──

/** AND di più bitmap: gli slot liberi per TUTTI. */
export function intersectFree(bitmaps: Buffer[]): Buffer {
  if (bitmaps.length === 0) return Buffer.alloc(0);
  const out = Buffer.from(bitmaps[0]);
  for (let k = 1; k < bitmaps.length; k++) {
    for (let i = 0; i < out.length; i++) out[i] &= bitmaps[k][i];
  }
  return out;
}

/** Per ogni slot, quanti utenti sono liberi (il "quanta luce passa"). */
export function countFreePerSlot(bitmaps: Buffer[], numSlots: number): number[] {
  const counts = new Array<number>(numSlots).fill(0);
  for (const b of bitmaps) {
    for (let i = 0; i < numSlots; i++) {
      if (getBit(b, i)) counts[i]++;
    }
  }
  return counts;
}

// ── funzioni di alto livello ──

/**
 * Scansiona una bitmap (di norma il risultato di intersectFree) e restituisce
 * le finestre libere di durata >= durationMinutes. Pura: testabile senza DB.
 * Le finestre non scavalcano la mezzanotte.
 */
export function scanFreeWindows(
  common: Buffer,
  fromDate: string,
  numSlots: number,
  durationMinutes: number,
  limit = 10
): FreeSlot[] {
  if (durationMinutes <= 0) return [];
  const need = Math.ceil(durationMinutes / SLOT_MINUTES);
  const slots: FreeSlot[] = [];
  let run = 0;
  for (let i = 0; i < numSlots && slots.length < limit; i++) {
    if (i % SLOTS_PER_DAY === 0) run = 0; // niente finestre a cavallo della mezzanotte
    run = getBit(common, i) ? run + 1 : 0;
    if (run >= need) {
      slots.push(slotWindow(fromDate, i - need + 1, durationMinutes));
      run = 0;
    }
  }
  return slots;
}

/**
 * Finestre libere per TUTTI gli userIds, di durata >= durationMinutes,
 * nell'intervallo [fromDate, toDate].
 */
export async function findCommonSlots(
  userIds: string[],
  fromDate: string,
  toDate: string,
  durationMinutes: number,
  limit = 10
): Promise<FreeSlot[]> {
  if (userIds.length === 0 || durationMinutes <= 0) return [];
  const numSlots = rangeDays(fromDate, toDate) * SLOTS_PER_DAY;
  const bitmaps = [...(await buildFreeBitmaps(userIds, fromDate, toDate)).values()];
  return scanFreeWindows(intersectFree(bitmaps), fromDate, numSlots, durationMinutes, limit);
}

/** Per ciascun utente: è libero nella finestra [date startTime-endTime]? */
export async function usersFreeAt(
  userIds: string[],
  date: string,
  startTime: string,
  endTime: string
): Promise<Array<{ userId: string; free: boolean }>> {
  const bitmaps = await buildFreeBitmaps(userIds, date, date);
  const first = Math.floor(timeToMinutes(startTime) / SLOT_MINUTES);
  const last = Math.ceil(timeToMinutes(endTime) / SLOT_MINUTES) - 1;
  return userIds.map((uid) => {
    const b = bitmaps.get(uid)!;
    let free = true;
    for (let i = first; i <= last; i++) {
      if (!getBit(b, i)) { free = false; break; }
    }
    return { userId: uid, free };
  });
}

function slotWindow(fromDate: string, startSlot: number, durationMinutes: number): FreeSlot {
  const d = parseDate(fromDate);
  d.setUTCDate(d.getUTCDate() + Math.floor(startSlot / SLOTS_PER_DAY));
  const startMin = (startSlot % SLOTS_PER_DAY) * SLOT_MINUTES;
  return {
    date: dateToStr(d),
    startTime: minutesToTime(startMin),
    endTime: minutesToTime(startMin + durationMinutes),
  };
}
