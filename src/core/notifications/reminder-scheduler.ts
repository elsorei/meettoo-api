import { queryMany, query } from '../../shared/db';

/**
 * Scheduler dei promemoria evento.
 *
 * Ogni minuto cerca gli eventi il cui promemoria ("avvisami N minuti prima")
 * è in scadenza e non ancora inviato, manda la push sonora a tutti i
 * partecipanti e marca l'invio (alarm_sent_at) perché parta una volta sola.
 */

// Fuso orario di riferimento dell'app (mercato italiano). Gli orari degli
// eventi sono "da calendario": li interpretiamo in questo fuso per sapere
// l'istante reale in cui far scattare il promemoria.
const APP_TZ = 'Europe/Rome';

interface DueEvent {
  id: string;
  title: string;
  start_time: string;
}

/** Trova i promemoria in scadenza, invia le push e li marca come inviati. */
export async function checkDueReminders(): Promise<void> {
  const due = await queryMany<DueEvent>(
    `SELECT e.id, e.title, e.start_time::text
     FROM events e
     WHERE e.alarm_minutes_before IS NOT NULL
       AND e.alarm_sent_at IS NULL
       AND e.recurrence_rule IS NULL
       AND e.start_time IS NOT NULL
       AND e.status IN ('pending', 'confirmed')
       AND e.closed = false
       AND ((e.event_date + e.start_time) AT TIME ZONE $1)
             - (e.alarm_minutes_before * interval '1 minute') <= NOW()
       AND ((e.event_date + e.start_time) AT TIME ZONE $1) > NOW() - interval '1 hour'`,
    [APP_TZ]
  );
  if (due.length === 0) return;

  const { sendPushToUsers } = await import('./push');
  const { createBulkNotifications } = await import('../../modules/notifications/notifications.service');

  for (const ev of due) {
    // Marca subito come inviato: la condizione su alarm_sent_at rende il
    // "claim" atomico, niente doppioni se due giri si sovrappongono.
    const claimed = await query(
      `UPDATE events SET alarm_sent_at = NOW() WHERE id = $1 AND alarm_sent_at IS NULL`,
      [ev.id]
    );
    if (!claimed.rowCount) continue;

    const parts = await queryMany<{ user_id: string }>(
      `SELECT user_id FROM event_participants WHERE event_id = $1`,
      [ev.id]
    );
    const userIds = parts.map((p) => p.user_id);
    if (userIds.length === 0) continue;

    const body = `«${ev.title}» alle ${ev.start_time.slice(0, 5)}`;
    await createBulkNotifications(userIds, 'event_reminder', 'Promemoria', body, { eventId: ev.id });
    await sendPushToUsers(userIds, 'Promemoria', body, {
      type: 'event_reminder',
      eventId: ev.id,
      url: '/agenda',
    });
  }
}

/** Avvia lo scheduler: controlla i promemoria ogni 60 secondi. */
export function startReminderScheduler(): void {
  setInterval(() => {
    checkDueReminders().catch((err) => console.error('[Reminder] errore scheduler:', err));
  }, 60_000);
  console.log('[Reminder] scheduler avviato (controllo ogni 60s)');
}
