/**
 * Verifica del motore bitmap delle disponibilità (parte pura, senza DB).
 * Esegui con:  ./node_modules/.bin/tsx src/modules/agenda/availability-engine.check.ts
 */
import {
  eventsToFreeBitmap,
  intersectFree,
  countFreePerSlot,
  scanFreeWindows,
  isFree,
  rangeDays,
} from './availability-engine';
import type { RawEvent } from './availability-engine';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}`);
  }
}

const DAY = '2026-06-01';

function ev(date: string, start: string, end: string, rule: string | null = null): RawEvent {
  return {
    event_date: date,
    start_time: start,
    end_time: end,
    recurrence_rule: rule,
    recurrence_exceptions: null,
  };
}

// indice di slot per un orario nel primo giorno
function slot(h: number, m = 0): number {
  return h * 4 + m / 15;
}

console.log('— eventsToFreeBitmap —');
{
  const b = eventsToFreeBitmap([], DAY, DAY);
  check('agenda vuota: slot 0 libero', isFree(b, 0));
  check('agenda vuota: slot 95 libero', isFree(b, 95));
}
{
  const b = eventsToFreeBitmap([ev(DAY, '10:00', '11:00')], DAY, DAY);
  check('10-11: slot 09:45 libero', isFree(b, slot(9, 45)));
  check('10-11: slot 10:00 occupato', !isFree(b, slot(10)));
  check('10-11: slot 10:45 occupato', !isFree(b, slot(10, 45)));
  check('10-11: slot 11:00 libero', isFree(b, slot(11)));
}
{
  const b = eventsToFreeBitmap([ev(DAY, '10:10', '10:50')], DAY, DAY);
  check('10:10-10:50: slot 40 occupato', !isFree(b, 40));
  check('10:10-10:50: slot 43 occupato', !isFree(b, 43));
  check('10:10-10:50: slot 44 libero', isFree(b, 44));
}
{
  const b = eventsToFreeBitmap([ev('2026-07-01', '10:00', '11:00')], DAY, DAY);
  check('evento fuori range: slot 40 libero', isFree(b, 40));
}
{
  const b = eventsToFreeBitmap([ev(DAY, '09:00', '10:00', 'FREQ=WEEKLY')], DAY, '2026-06-08');
  check('ricorrenza: giorno 0 alle 09:00 occupato', !isFree(b, slot(9)));
  check('ricorrenza: giorno 7 alle 09:00 occupato', !isFree(b, 7 * 96 + slot(9)));
  check('ricorrenza: giorno 1 alle 09:00 libero', isFree(b, 1 * 96 + slot(9)));
}

console.log('— intersectFree —');
{
  const a = eventsToFreeBitmap([ev(DAY, '10:00', '11:00')], DAY, DAY); // occupa 40-43
  const c = eventsToFreeBitmap([ev(DAY, '10:30', '11:30')], DAY, DAY); // occupa 42-45
  const both = intersectFree([a, c]);
  check('intersect: slot 39 libero per entrambi', isFree(both, 39));
  check('intersect: slot 41 occupato (occupato in A)', !isFree(both, 41));
  check('intersect: slot 42 occupato (occupato in entrambi)', !isFree(both, 42));
  check('intersect: slot 44 occupato (occupato in C)', !isFree(both, 44));
  check('intersect: slot 46 libero per entrambi', isFree(both, 46));
}

console.log('— countFreePerSlot —');
{
  const a = eventsToFreeBitmap([ev(DAY, '10:00', '10:15')], DAY, DAY);
  const c = eventsToFreeBitmap([ev(DAY, '10:00', '10:15')], DAY, DAY);
  const d = eventsToFreeBitmap([], DAY, DAY);
  const counts = countFreePerSlot([a, c, d], 96);
  check('count: slot 40 -> 1 libero su 3', counts[40] === 1);
  check('count: slot 0 -> 3 liberi su 3', counts[0] === 3);
}

console.log('— scanFreeWindows —');
{
  const b = eventsToFreeBitmap([ev(DAY, '00:00', '10:00'), ev(DAY, '12:00', '23:45')], DAY, DAY);
  const win = scanFreeWindows(b, DAY, 96, 60, 10);
  check('scan: 2 finestre da 60 min nel buco 10-12', win.length === 2);
  check('scan: prima finestra inizia 10:00', win[0]?.startTime === '10:00');
  check('scan: prima finestra finisce 11:00', win[0]?.endTime === '11:00');
  check('scan: seconda finestra inizia 11:00', win[1]?.startTime === '11:00');
}
{
  const b = eventsToFreeBitmap([ev(DAY, '00:00', '10:00'), ev(DAY, '12:00', '23:45')], DAY, DAY);
  const win = scanFreeWindows(b, DAY, 96, 180, 10);
  check('scan: nessuna finestra da 3h in un buco da 2h', win.length === 0);
}

console.log('— rangeDays —');
check('rangeDays stesso giorno = 1', rangeDays(DAY, DAY) === 1);
check('rangeDays 8 giorni', rangeDays(DAY, '2026-06-08') === 8);

console.log(`\nRisultato: ${passed} PASS, ${failed} FAIL`);
process.exit(failed > 0 ? 1 : 0);
