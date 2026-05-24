import { queryMany } from '../../shared/db';
import { ListPublicFeedQuery } from './feed.schema';

// Item esposto dal feed pubblico. Snake_case in tutto il payload, coerente
// con il resto del codebase (vedi CLAUDE.md "Convenzioni minori").
export interface PublicFeedItem {
  id: string;
  title: string;
  description: string | null;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  cover_url: string | null;
  owner_id: string;
  owner_name: string;
  visibility: 'public_view' | 'public_open';
  attachments_count: number;
  external_links_count: number;
}

interface FeedRow {
  id: string;
  title: string;
  description: string | null;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  cover_attachment_id: string | null;
  owner_id: string;
  owner_name: string;
  visibility: 'public_view' | 'public_open';
  attachments_count: string;
  external_links_count: string;
}

// L'endpoint download allegati richiede auth ed espone il file via
// /api/events/<eventId>/attachments/<attId>/download. Costruiamo l'URL
// relativo qui — il client farà già la richiesta con il proprio JWT.
function buildCoverUrl(eventId: string, attachmentId: string | null): string | null {
  if (!attachmentId) return null;
  return `/api/events/${eventId}/attachments/${attachmentId}/download`;
}

/**
 * Elenca gli eventi pubblicati al feed (visibility IN public_view/public_open),
 * non cancellati, datati da ieri in poi. Ordinati per data crescente, poi
 * per creazione decrescente. Paginazione via limit/offset.
 *
 * Sicurezza: il chiamante deve essere autenticato (vedi feed.routes.ts).
 * Per ora il feed non è aperto agli anonimi — solo utenti loggati di Meettoo.
 */
export async function listPublicFeed(filters: ListPublicFeedQuery): Promise<PublicFeedItem[]> {
  const conditions: string[] = [
    `e.visibility IN ('public_view','public_open')`,
    `e.status <> 'cancelled'`,
    `e.closed = false`,
  ];
  const params: any[] = [];
  let idx = 1;

  // Default: da ieri in poi (NOW()::date - 1) per non perdere eventi "oggi"
  // a cavallo della mezzanotte di chi consulta.
  if (filters.from) {
    conditions.push(`e.event_date >= $${idx}`);
    params.push(filters.from);
    idx++;
  } else {
    conditions.push(`e.event_date >= (NOW()::date - 1)`);
  }
  if (filters.to) {
    conditions.push(`e.event_date <= $${idx}`);
    params.push(filters.to);
    idx++;
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;

  // Tipi enum -> text con cast esplicito (visibility::text).
  const rows = await queryMany<FeedRow>(
    `SELECT
        e.id,
        e.title,
        e.description,
        e.event_date::text       AS event_date,
        e.start_time::text       AS start_time,
        e.end_time::text         AS end_time,
        e.cover_attachment_id,
        e.owner_id,
        COALESCE(u.name, u.username) AS owner_name,
        e.visibility::text       AS visibility,
        (SELECT COUNT(*) FROM event_attachments      WHERE event_id = e.id) AS attachments_count,
        (SELECT COUNT(*) FROM event_external_links   WHERE event_id = e.id) AS external_links_count
      FROM events e
      JOIN users u ON u.id = e.owner_id
      ${whereClause}
      ORDER BY e.event_date ASC, e.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, filters.limit, filters.offset]
  );

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    event_date: r.event_date,
    start_time: r.start_time,
    end_time: r.end_time,
    cover_url: buildCoverUrl(r.id, r.cover_attachment_id),
    owner_id: r.owner_id,
    owner_name: r.owner_name,
    visibility: r.visibility,
    attachments_count: parseInt(r.attachments_count, 10) || 0,
    external_links_count: parseInt(r.external_links_count, 10) || 0,
  }));
}
