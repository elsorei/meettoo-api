import { queryOne } from '../../shared/db';

/**
 * Info minime e pubblicabili di un evento, per la pagina web d'invito.
 * NON espone la lista invitati né le email (vedi BE-3): solo ciò che serve
 * a invogliare chi riceve il link (titolo, quando, dove, chi organizza,
 * quante persone). È la classica invite-page stile Partiful/Luma.
 */
export interface LandingEvent {
  id: string;
  title: string;
  event_date: string;
  start_time: string | null;
  location_name: string | null;
  host_name: string;
  guest_count: number;
}

export async function getLandingEvent(eventId: string): Promise<LandingEvent | null> {
  // UUID malformato → nessun evento (evita errori 500 su input arbitrario).
  if (!/^[0-9a-f-]{16,}$/i.test(eventId)) return null;

  const row = await queryOne<{
    id: string;
    title: string;
    event_date: string;
    start_time: string | null;
    location_name: string | null;
    host_name: string;
    guest_count: string;
  }>(
    `SELECT e.id, e.title, e.event_date::text AS event_date, e.start_time::text AS start_time,
            e.location_name,
            COALESCE(u.name, u.username) AS host_name,
            (SELECT COUNT(*) FROM event_guests g WHERE g.event_id = e.id) AS guest_count
     FROM events e
     JOIN users u ON u.id = e.owner_id
     WHERE e.id = $1 AND e.status <> 'cancelled'`,
    [eventId]
  );
  if (!row) return null;
  return { ...row, guest_count: Number(row.guest_count) };
}
