import { queryOne, queryMany, query, transaction } from '../../shared/db';
import { PoolClient } from 'pg';
import { RRule } from 'rrule';
import { NotFoundError, ForbiddenError, BadRequestError } from '../../core/errors';
import { CreateEventInput, UpdateEventInput, ListEventsQuery } from './agenda.schema';
import { Role, hasMinimumRole, isStaff } from '../../core/auth/roles';
import { syncEventToGCalAsync, deleteEventFromGCalAsync } from './gcalendar.hooks';
import { triggerNewEvent } from '../../core/notifications/triggers';
import { getEffectiveLevel } from '../sharing/sharing.service';
import { invalidateEvent } from './availability-engine';
import * as guestsService from './guests.service';
import { saveUploadedFile, deleteUploadedFile, getAbsolutePath } from '../../shared/file-upload';
import { existsSync } from 'fs';

// ── Types ──

interface EventRow {
  id: string;
  type: string;
  title: string;
  description: string | null;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  status: string;
  has_alarm: boolean;
  alarm_datetime: string | null;
  alarm_dismissed: boolean;
  confirmation_deadline: string | null;
  owner_id: string;
  gcalendar_event_id: string | null;
  gcalendar_synced_at: string | null;
  metadata: any;
  closed: boolean;
  recurrence_rule: string | null;
  recurrence_exceptions: string[];
  created_at: string;
  updated_at: string;
  // 042: geolocalizzazione (location + timezone evento).
  location_name: string | null;
  location_lat: string | null;
  location_lng: string | null;
  timezone: string;
}

interface ParticipantRow {
  id: string;
  event_id: string;
  user_id: string;
  role: string;
  confirmation: string;
  confirmed_at: string | null;
  username: string;
  user_role: string;
  display_name: string;
  photo_url: string | null;
}

interface AttachmentRow {
  id: string;
  file_name: string;
  file_path: string;
  file_size: number | null;
  mime_type: string | null;
  created_at: string;
}

// ── Sprint 3.5.1: visibility + external links ──

interface ExternalLinkRow {
  id: string;
  event_id: string;
  url: string;
  title: string | null;
  image_url: string | null;
  source: string;
  position: number;
  created_at: string;
}

// Visibilità che espongono l'evento al feed pubblico. Qualunque mutation
// che sposti l'evento in uno di questi stati richiede un account "maturo"
// (vedi assertCanPublishPublic). MVP: 1 ora.
const PUBLIC_VISIBILITIES = new Set(['public_view', 'public_open']);
const PUBLIC_PUBLISH_MIN_ACCOUNT_AGE_MS = 60 * 60 * 1000; // 1h (MVP — più avanti 30gg)

async function assertCanPublishPublic(
  userId: string,
  visibility: string | undefined
): Promise<void> {
  if (!visibility || !PUBLIC_VISIBILITIES.has(visibility)) return;

  const row = await queryOne<{ created_at: string }>(
    `SELECT created_at FROM users WHERE id = $1`,
    [userId]
  );
  if (!row) throw new ForbiddenError('User not found');

  const createdAt = new Date(row.created_at).getTime();
  if (Number.isNaN(createdAt) || Date.now() - createdAt < PUBLIC_PUBLISH_MIN_ACCOUNT_AGE_MS) {
    throw new ForbiddenError(
      "La pubblicazione al feed pubblico richiede un account più maturo. Prova invitati o amici."
    );
  }
}

async function insertExternalLinks(
  client: PoolClient,
  eventId: string,
  links: Array<{ url: string; title?: string; imageUrl?: string; source?: string; position: number }>
): Promise<void> {
  for (const link of links) {
    await client.query(
      `INSERT INTO event_external_links
         (event_id, url, title, image_url, source, position)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        eventId,
        link.url,
        link.title ?? null,
        link.imageUrl ?? null,
        link.source ?? 'web',
        link.position,
      ]
    );
  }
}

async function fetchExternalLinks(eventId: string): Promise<ExternalLinkRow[]> {
  return queryMany<ExternalLinkRow>(
    `SELECT id, event_id, url, title, image_url, source, position, created_at
     FROM event_external_links
     WHERE event_id = $1
     ORDER BY position ASC, created_at ASC`,
    [eventId]
  );
}

// ── CREATE ──

export async function createEvent(
  requesterId: string,
  input: CreateEventInput
): Promise<any> {
  // Se forOperatorUserId è specificato, l'evento viene creato sull'agenda del collaboratore.
  // Il creatore NON viene aggiunto come partecipante automaticamente:
  // il coordinatore assegna compiti senza intasare la propria agenda.
  // created_by_id traccia chi ha creato/assegnato l'evento.
  const ownerId = input.forOperatorUserId || requesterId;
  const createdById = input.forOperatorUserId ? requesterId : null;

  // Creare un evento sull'agenda di QUALCUN ALTRO richiede di essere staff
  // interno oppure di avere un permesso 'write' concesso dal proprietario.
  if (ownerId !== requesterId) {
    const requester = await queryOne<{ role: Role }>(
      `SELECT role FROM users WHERE id = $1`, [requesterId]
    );
    if (!isStaff(requester?.role || 'client')) {
      const level = await getEffectiveLevel(
        ownerId, requesterId, requester?.role || 'client', 'agenda'
      );
      if (level !== 'write') {
        throw new ForbiddenError("You cannot create events on another user's agenda");
      }
    }
  }

  // Guardia anti-abuso sul feed pubblico: account troppo giovane non può
  // pubblicare in 'public_view'/'public_open' (vedi assertCanPublishPublic).
  await assertCanPublishPublic(ownerId, input.visibility);

  // 042: se il client non passa una timezone per l'evento, eredita quella
  // dell'utente owner (così un utente con tz='Europe/Paris' crea eventi
  // con quella tz senza doverla rispecificare).
  let eventTimezone: string | undefined = input.timezone;
  if (eventTimezone === undefined) {
    const ownerRow = await queryOne<{ timezone: string }>(
      `SELECT timezone FROM users WHERE id = $1`,
      [ownerId]
    );
    eventTimezone = ownerRow?.timezone;
  }

  const { eventId, linkedDeadlineId } = await transaction(async (client: PoolClient) => {
    // Insert event (con created_by_id se assegnato da un altro operatore).
    // Sprint 3.5.1: scrive anche visibility e cover_attachment_id.
    // 042: scrive anche location_name/lat/lng + timezone (con cast NUMERIC
    // su lat/lng perché zod manda number ma la colonna è NUMERIC).
    const eventResult = await client.query(
      `INSERT INTO events (type, title, description, event_date, start_time, end_time,
                           has_alarm, alarm_datetime, alarm_minutes_before, confirmation_deadline,
                           owner_id, metadata, recurrence_rule, created_by_id, is_private,
                           visibility, cover_attachment_id,
                           location_name, location_lat, location_lng, timezone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
               COALESCE($16::event_visibility, 'invitees'::event_visibility), $17,
               $18, $19::numeric, $20::numeric,
               COALESCE($21, 'Europe/Rome'))
       RETURNING id`,
      [
        input.type,
        input.title,
        input.description || null,
        input.eventDate,
        input.startTime || null,
        input.endTime || null,
        input.hasAlarm,
        input.alarmDatetime || null,
        input.alarmMinutesBefore ?? null,
        input.confirmationDeadline || null,
        ownerId,
        JSON.stringify(input.metadata || {}),
        input.recurrenceRule || null,
        createdById,
        input.isPrivate === true,
        input.visibility ?? null,
        input.coverAttachmentId ?? null,
        input.locationName ?? null,
        input.locationLat ?? null,
        input.locationLng ?? null,
        eventTimezone ?? null,
      ]
    );

    const newId = eventResult.rows[0].id;

    // Link esterni: insert in batch nella stessa transazione.
    if (input.externalLinks && input.externalLinks.length > 0) {
      await insertExternalLinks(client, newId, input.externalLinks);
    }

    // Add owner as organizer participant
    await client.query(
      `INSERT INTO event_participants (event_id, user_id, role, confirmation, confirmed_at)
       VALUES ($1, $2, 'organizer', 'accepted', NOW())`,
      [newId, ownerId]
    );

    // Add additional participants (il creatore può aggiungersi manualmente se vuole partecipare)
    if (input.participants && input.participants.length > 0) {
      for (const p of input.participants) {
        if (p.userId === ownerId) continue;
        await client.query(
          `INSERT INTO event_participants (event_id, user_id, role, confirmation)
           VALUES ($1, $2, $3, 'pending')
           ON CONFLICT (event_id, user_id) DO NOTHING`,
          [newId, p.userId, p.role]
        );
      }
    }

    // ── Scadenza correlata (linkedDeadline) ──
    // Crea un secondo evento di tipo 'commitment' senza orario, datato
    // `offsetDays` giorni prima dell'evento principale. Solo l'owner come
    // organizer, niente altri partecipanti. linked_event_id punta al primo.
    let linkedId: string | null = null;
    if (input.linkedDeadline) {
      const deadlineTitle =
        input.linkedDeadline.title?.trim() || `Scadenza: ${input.title}`;
      // Calcolo data: sottrai offsetDays. Usiamo SQL per evitare drift di
      // timezone lato JS (event_date è DATE, non TIMESTAMPTZ).
      const linkedResult = await client.query(
        `INSERT INTO events (type, title, description, event_date, start_time, end_time,
                             has_alarm, owner_id, metadata, created_by_id, is_private,
                             linked_event_id)
         VALUES ('commitment', $1, NULL,
                 ($2::date - ($3::int))::date,
                 NULL, NULL,
                 false, $4, '{}'::jsonb, $5, $6, $7)
         RETURNING id`,
        [
          deadlineTitle,
          input.eventDate,
          input.linkedDeadline.offsetDays,
          ownerId,
          createdById,
          input.isPrivate === true,
          newId,
        ]
      );
      linkedId = linkedResult.rows[0].id as string;

      // Owner organizer anche sulla scadenza, per coerenza con il pattern
      // (la getCalendarEvents filtra owner_id OR partecipante).
      await client.query(
        `INSERT INTO event_participants (event_id, user_id, role, confirmation, confirmed_at)
         VALUES ($1, $2, 'organizer', 'accepted', NOW())`,
        [linkedId, ownerId]
      );
    }

    return { eventId: newId as string, linkedDeadlineId: linkedId };
  });

  // Async sync to Google Calendar (non-blocking)
  syncEventToGCalAsync(eventId, ownerId);

  // Notify all participants (except owner) to confirm
  if (input.participants && input.participants.length > 0) {
    const participantUserIds = input.participants.map(p => p.userId);
    setImmediate(() => {
      triggerNewEvent(eventId, input.title, participantUserIds, ownerId).catch(err =>
        console.error('[Agenda] Failed to send notifications:', err)
      );
    });
  }

  await invalidateEvent(eventId);
  if (linkedDeadlineId) await invalidateEvent(linkedDeadlineId);

  const eventDetail = await getEventById(eventId, ownerId);
  return {
    ...eventDetail,
    linked_deadline: linkedDeadlineId ? { id: linkedDeadlineId } : null,
  };
}

// ── READ ──

export async function getEventById(eventId: string, requesterId: string): Promise<any> {
  const event = await queryOne<EventRow & {
    owner_name: string;
    owner_photo: string | null;
    created_by_name: string | null;
    created_by_photo: string | null;
    linked_event_id: string | null;
    visibility: string;
    cover_attachment_id: string | null;
  }>(
    `SELECT e.*, e.event_date::text as event_date,
            COALESCE(u.name, u.username) as owner_name,
            u.photo_url as owner_photo,
            COALESCE(ucb.name, ucb.username) as created_by_name,
            ucb.photo_url as created_by_photo
     FROM events e
     JOIN users u ON u.id = e.owner_id
     LEFT JOIN users ucb ON ucb.id = e.created_by_id
     WHERE e.id = $1`,
    [eventId]
  );

  if (!event) throw new NotFoundError('Event not found');

  // Check access: must be owner or participant (o invitato guest, 047)
  const isParticipantRow = await queryOne(
    `SELECT 1 FROM event_participants WHERE event_id = $1 AND user_id = $2`,
    [eventId, requesterId]
  );
  const isParticipant =
    !!isParticipantRow || (await guestsService.isGuest(eventId, requesterId));

  // Also check if requester is admin/owner or has calendar permission
  const requester = await queryOne<{ role: Role }>(
    `SELECT role FROM users WHERE id = $1`,
    [requesterId]
  );

  const isCreator = (event as any).created_by_id === requesterId;
  const isOwner   = event.owner_id === requesterId;
  const isAdmin   = hasMinimumRole(requester?.role || 'client', 'admin');
  // Sprint 3.5.1: eventi pubblici (public_view/public_open) sono leggibili
  // da chiunque autenticato — il check di accesso si rilassa, ma le
  // mutations restano riservate all'owner (vedi updateEvent/deleteEvent).
  const isPubliclyReadable = PUBLIC_VISIBILITIES.has(event.visibility);

  if (!isParticipant && !isOwner && !isCreator && !isAdmin && !isPubliclyReadable) {
    // Solo lo staff interno (operator+) vede le agende dei colleghi senza
    // permessi espliciti. Gli account consumer ('user'/'client') devono avere
    // un permesso white/write concesso dal proprietario dell'evento.
    if (!isStaff(requester?.role || 'client')) {
      const level = await getEffectiveLevel(
        event.owner_id, requesterId, requester?.role || 'client', 'agenda'
      );
      if (level !== 'white' && level !== 'write') {
        throw new ForbiddenError('You do not have access to this event');
      }
    }
  }

  // ── Regola B+C: privacy "intrinseca" anche sull'accesso per ID ──
  // Un operatore "collega" (non owner, non partecipante, non creator, non admin)
  // non può aprire reminders altrui o eventi marcati is_private — anche se
  // tecnicamente avrebbe accesso "in chiaro" via permesso white/write.
  // Owner/partecipante/creator/admin continuano a vedere tutto.
  // Eccezione Sprint 3.5.1: per eventi public_view/public_open il filtro
  // privacy/reminder non scatta (non sono privati per definizione).
  if (!isParticipant && !isOwner && !isCreator && !isAdmin && !isPubliclyReadable) {
    const isPrivateEvent = (event as any).is_private === true;
    const isReminder     = event.type === 'reminder';
    if (isPrivateEvent || isReminder) {
      throw new ForbiddenError('You do not have access to this event');
    }
  }

  // Fetch participants with user info
  const participants = await queryMany<ParticipantRow>(
    `SELECT ep.id, ep.event_id, ep.user_id, ep.role, ep.confirmation, ep.confirmed_at,
            u.username, u.role as user_role,
            COALESCE(u.name, u.username) as display_name,
            u.photo_url
     FROM event_participants ep
     JOIN users u ON u.id = ep.user_id
     WHERE ep.event_id = $1
     ORDER BY ep.role DESC, ep.confirmation`,
    [eventId]
  );

  // Fetch attachments
  const attachments = await queryMany<AttachmentRow>(
    `SELECT id, file_name, file_path, file_size, mime_type, created_at
     FROM event_attachments WHERE event_id = $1 ORDER BY created_at`,
    [eventId]
  );

  // Carica l'evento linkato (se presente). Permette al client di mostrare
  // "Scadenza correlata a: ...". Niente ricorsione: solo il primo livello.
  let linkedEvent: { id: string; title: string; type: string; event_date: string } | null = null;
  if (event.linked_event_id) {
    linkedEvent = await queryOne<{ id: string; title: string; type: string; event_date: string }>(
      `SELECT id, title, type, event_date::text as event_date
       FROM events WHERE id = $1`,
      [event.linked_event_id]
    );
  }

  // Sprint 3.5.1: link esterni dell'evento (post-style).
  const externalLinks = await fetchExternalLinks(eventId);

  // Inviti guest (047): roster, flag "gli invitati possono invitare" e
  // can_invite calcolato per il richiedente (la UI si limita a rispecchiarlo).
  const canInviteFlag = await guestsService.canInvite(
    event as any,
    requesterId
  );

  // Le email degli invitati sono PII: un evento pubblico è leggibile da
  // chiunque, ma il roster con le email va mostrato solo a chi ha una
  // relazione con l'evento (owner/creator/partecipante/invitato/admin).
  // Agli altri (visitatori di un evento pubblico) diamo solo il conteggio.
  const isInsider = isOwner || isCreator || isParticipant || isAdmin;
  const guests = isInsider
    ? await guestsService.listGuests(eventId)
    : [];
  const guestCount = isInsider
    ? guests.length
    : await guestsService.countGuests(eventId);

  return {
    ...event,
    participants,
    attachments,
    linked_event: linkedEvent,
    external_links: externalLinks,
    guests,
    guest_count: guestCount,
    can_invite: canInviteFlag,
  };
}

export async function listEvents(
  requesterId: string,
  requesterRole: Role,
  filters: ListEventsQuery
): Promise<{ events: any[]; total: number }> {
  const conditions: string[] = [];
  const params: any[] = [];
  let paramIndex = 1;

  // Base: events where user is owner or participant (or admin sees all)
  if (!hasMinimumRole(requesterRole, 'admin')) {
    conditions.push(`(e.owner_id = $${paramIndex} OR ep.user_id = $${paramIndex})`);
    params.push(requesterId);
    paramIndex++;
  }

  // Filter by date range
  if (filters.from) {
    conditions.push(`e.event_date >= $${paramIndex}`);
    params.push(filters.from);
    paramIndex++;
  }
  if (filters.to) {
    conditions.push(`e.event_date <= $${paramIndex}`);
    params.push(filters.to);
    paramIndex++;
  }

  // Filter by type
  if (filters.type) {
    conditions.push(`e.type = $${paramIndex}`);
    params.push(filters.type);
    paramIndex++;
  }

  // Filter by status
  if (filters.status) {
    conditions.push(`e.status = $${paramIndex}`);
    params.push(filters.status);
    paramIndex++;
  }

  // Filter by specific operator (via user_id)
  if (filters.operatorId) {
    conditions.push(`(e.owner_id = $${paramIndex} OR ep.user_id = $${paramIndex})`);
    params.push(filters.operatorId);
    paramIndex++;
  }

  // Filter by specific client (via user_id)
  if (filters.clientId) {
    conditions.push(`ep.user_id = $${paramIndex}`);
    params.push(filters.clientId);
    paramIndex++;
  }

  // Filter by closed state
  if (filters.closed !== undefined) {
    conditions.push(`e.closed = $${paramIndex}`);
    params.push(filters.closed === 'true');
    paramIndex++;
  }

  const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

  // Count total
  const countResult = await queryOne<{ count: string }>(
    `SELECT COUNT(DISTINCT e.id) as count
     FROM events e
     LEFT JOIN event_participants ep ON ep.event_id = e.id
     ${whereClause}`,
    params
  );
  const total = parseInt(countResult?.count || '0', 10);

  // Fetch events with pagination
  const offset = (filters.page - 1) * filters.limit;
  const events = await queryMany(
    `SELECT e.id, e.type, e.title, e.event_date::text as event_date,
            e.start_time::text, e.end_time::text, e.status,
            e.has_alarm, e.alarm_datetime, e.closed,
            e.owner_id, e.created_at, e.updated_at,
            e.location_name, e.location_lat, e.location_lng, e.timezone,
            COALESCE(owner_u.name, owner_u.username) as owner_name,
            (SELECT COUNT(*) FROM event_participants WHERE event_id = e.id) as participant_count,
            (SELECT COUNT(*) FROM event_attachments WHERE event_id = e.id) as attachment_count,
            (SELECT ep_me.confirmation FROM event_participants ep_me WHERE ep_me.event_id = e.id AND ep_me.user_id = $${paramIndex}) as my_confirmation
     FROM events e
     LEFT JOIN users owner_u ON owner_u.id = e.owner_id
     WHERE e.id IN (
       SELECT DISTINCT e2.id FROM events e2
       LEFT JOIN event_participants ep ON ep.event_id = e2.id
       ${whereClause}
     )
     ORDER BY e.event_date DESC, e.start_time ASC NULLS LAST
     LIMIT $${paramIndex + 1} OFFSET $${paramIndex + 2}`,
    [...params, requesterId, filters.limit, offset]
  );

  return { events, total };
}

/**
 * Get calendar events formatted for FullCalendar-style rendering.
 * Returns a flat array with color coding by type.
 */
export async function getCalendarEvents(
  requesterId: string,
  requesterRole: Role,
  from: string,
  to: string,
  operatorId?: string
): Promise<any[]> {
  const targetUserId = operatorId || requesterId;

  // Solo lo staff interno (operator/admin/owner) può aprire i calendari dei
  // colleghi senza permesso esplicito. Gli account consumer ('user'/'client')
  // possono vedere il calendario di un altro utente SOLO se questi ha
  // concesso un permesso in share_permissions (anche solo 'ghost').
  if (operatorId && operatorId !== requesterId && !isStaff(requesterRole)) {
    const grant = await queryOne<{ level: string }>(
      `SELECT level FROM share_permissions
       WHERE resource_type = 'agenda' AND grantor_user_id = $1 AND grantee_user_id = $2`,
      [operatorId, requesterId]
    );
    if (!grant) {
      throw new ForbiddenError('No permission to view this calendar');
    }
  }

  // Quando si guarda il calendario di un altro operatore, applichiamo il
  // livello di accesso effettivo:
  //   - admin/owner → 'white' (vedono dettagli)
  //   - operator → 'ghost' di default; può essere alzato a 'white'/'write'
  //     se il proprietario del calendario ha concesso esplicito permesso
  //     in share_permissions.
  const isViewingOther = !!(operatorId && operatorId !== requesterId);
  const accessLevel = isViewingOther
    ? await getEffectiveLevel(targetUserId, requesterId, requesterRole, 'agenda')
    : 'write';
  const shouldMask = accessLevel === 'ghost';

  const rawEvents = await queryMany(
    `SELECT e.id, e.type, e.title, e.description,
            e.event_date::text, e.start_time::text, e.end_time::text,
            e.status, e.has_alarm, e.alarm_datetime, e.closed, e.owner_id,
            e.recurrence_rule, e.recurrence_exceptions, e.is_private,
            e.location_name, e.location_lat, e.location_lng, e.timezone,
            (e.owner_id = $3) as is_mine
     FROM events e
     WHERE e.id IN (
       SELECT DISTINCT e2.id FROM events e2
       LEFT JOIN event_participants ep ON ep.event_id = e2.id
       WHERE (e2.owner_id = $3 OR ep.user_id = $3)
         AND (
           (e2.recurrence_rule IS NULL AND e2.event_date >= $1 AND e2.event_date <= $2)
           OR (e2.recurrence_rule IS NOT NULL AND e2.event_date <= $2)
         )
         AND e2.closed = false
     )
     ORDER BY e.event_date, e.start_time NULLS LAST`,
    [from, to, targetUserId]
  );

  // Espandi gli eventi ricorrenti nelle loro singole occorrenze nel range
  const events: any[] = [];
  for (const ev of rawEvents) {
    if (!ev.recurrence_rule) {
      events.push(ev);
      continue;
    }
    try {
      const time   = ev.start_time ? ev.start_time.substring(0, 5) : '00:00';
      const [hh, mm] = time.split(':');
      const dtBase  = ev.event_date.replace(/-/g, '');
      const dtstart = `DTSTART:${dtBase}T${hh.padStart(2,'0')}${mm.padStart(2,'0')}00\n`;
      const rule    = RRule.fromString(`${dtstart}RRULE:${ev.recurrence_rule}`);

      const fromDt = new Date(`${from}T00:00:00`);
      const toDt   = new Date(`${to}T23:59:59`);
      const occurrences = rule.between(fromDt, toDt, true);

      const exceptions: string[] = ev.recurrence_exceptions || [];
      for (const occ of occurrences) {
        const occDate = occ.toISOString().split('T')[0];
        if (exceptions.includes(occDate)) continue;
        events.push({ ...ev, event_date: occDate, _real_id: ev.id, _occurrence: true });
      }
    } catch (err) {
      console.error('[Recurring] expand error for event', ev.id, err);
      events.push(ev); // fallback: show original
    }
  }

  // Color mapping
  const colors: Record<string, string> = {
    appointment: '#8B4513',  // rosso mattone
    commitment: '#3c8dbc',   // azzurro
    reminder: '#e67e22',     // arancio
  };

  // Fetch participants for all events in one query
  const eventIds = events.map((e: any) => e.id);
  const participants = eventIds.length > 0 ? await queryMany(
    `SELECT ep.event_id, ep.user_id, ep.role, ep.confirmation,
            COALESCE(u.name, u.username) as display_name,
            u.role as user_role
     FROM event_participants ep
     JOIN users u ON u.id = ep.user_id
     WHERE ep.event_id = ANY($1)`,
    [eventIds]
  ) : [];

  // Group participants by event
  const partByEvent = new Map<string, any[]>();
  for (const p of participants) {
    if (!partByEvent.has(p.event_id)) partByEvent.set(p.event_id, []);
    partByEvent.get(p.event_id)!.push(p);
  }

  return events.map((e: any) => {
    const parts = partByEvent.get(e.id) || [];
    // Find requester's own participation
    const myParticipation = parts.find((p: any) => p.user_id === targetUserId);
    const myConfirmation = myParticipation?.confirmation || 'pending';

    // Skip events the user has declined
    if (myConfirmation === 'declined') return null;

    // ── Regola B+C: privacy "intrinseca" dell'evento, indipendente dal level ──
    // I promemoria sono note personali e gli eventi marcati is_private sono
    // riservati: NON appaiono mai nel calendario di chi non sia admin/owner,
    // a prescindere dal livello concesso (anche white/write). Admin/owner
    // continuano a vedere tutto (loro sopra il diritto operator-vs-operator).
    const hidesPrivate = isViewingOther && !hasMinimumRole(requesterRole, 'admin');
    if (hidesPrivate && (e.type === 'reminder' || e.is_private === true)) {
      return null;
    }

    // ── Privacy masking "per livello" quando si guarda il calendario di un altro ──
    // shouldMask = true SOLO se il livello effettivo è 'ghost'.
    // 'white' e 'write' vedono tutti i dettagli (esclusi reminder/private filtrati sopra).
    if (shouldMask) {
      // Impegni: blocco anonimo azzurro senza titolo né dettagli
      if (e.type === 'commitment') {
        // Salta se non ha orario (non blocca slot specifici)
        if (!e.start_time) return null;
        const fcId = e._occurrence ? `${e._real_id}_${e.event_date}` : e.id;
        return {
          id: fcId,
          title: 'Occupato',
          start: `${e.event_date}T${e.start_time}`,
          end: e.end_time ? `${e.event_date}T${e.end_time}` : undefined,
          allDay: false,
          color: '#2471a3',
          extendedProps: {
            type: 'commitment',
            isMasked: true,
            status: 'confirmed',
            myConfirmation: 'accepted',
            isMine: false,
            isRecurring: !!e.recurrence_rule,
            occurrenceDate: e._occurrence ? e.event_date : undefined,
            realEventId: e._real_id || e.id,
            description: null,
            confirmSummary: { total: 0, accepted: 0, declined: 0, pending: 0 },
            participants: [],
          },
        };
      }
    }
    // ── Fine privacy masking ──

    // Color logic:
    // - Appointment: rosso mattone (#8B4513), confermato → verde (#28a745)
    // - Commitment: sempre azzurro (#3c8dbc)
    // - Reminder: sempre arancio (#e67e22)
    let eventColor = colors[e.type] || '#999';
    if (e.type === 'appointment') {
      if (e.status === 'confirmed' || myConfirmation === 'accepted') {
        eventColor = '#28a745'; // verde
      }
      // altrimenti resta rosso mattone
    }

    // Per occorrenze ricorrenti usa ID univoco ma mantieni il realEventId
    const fcId = e._occurrence ? `${e._real_id}_${e.event_date}` : e.id;
    const realEventId = e._real_id || e.id;

    return {
      id: fcId,
      title: e.title,
      start: e.start_time
        ? `${e.event_date}T${e.start_time}`
        : e.event_date,
      end: e.end_time
        ? `${e.event_date}T${e.end_time}`
        : undefined,
      allDay: !e.start_time,
      color: eventColor,
      extendedProps: {
        type: e.type,
        status: e.status,
        myConfirmation,
        hasAlarm: e.has_alarm,
        isMine: e.is_mine,
        description: e.description,
        isRecurring: !!e.recurrence_rule,
        occurrenceDate: e._occurrence ? e.event_date : undefined,
        realEventId,
        // 042: location + timezone — snake_case coerente con i DTO del modulo.
        location_name: e.location_name ?? null,
        location_lat: e.location_lat ?? null,
        location_lng: e.location_lng ?? null,
        timezone: e.timezone,
        confirmSummary: {
          total: parts.filter((p: any) => p.role !== 'organizer').length,
          accepted: parts.filter((p: any) => p.role !== 'organizer' && p.confirmation === 'accepted').length,
          declined: parts.filter((p: any) => p.role !== 'organizer' && p.confirmation === 'declined').length,
          pending: parts.filter((p: any) => p.role !== 'organizer' && p.confirmation === 'pending').length,
        },
        participants: parts.map((p: any) => ({
          name: p.display_name,
          role: p.role,
          confirmation: p.confirmation,
          isClient: p.user_role === 'client',
        })),
      },
    };
  }).filter(Boolean);
}

// ── UPDATE ──

export async function updateEvent(
  eventId: string,
  requesterId: string,
  requesterRole: Role,
  input: UpdateEventInput
): Promise<any> {
  const event = await queryOne<EventRow>(
    `SELECT * FROM events WHERE id = $1`,
    [eventId]
  );
  if (!event) throw new NotFoundError('Event not found');

  const beforeParticipantIds = (
    await queryMany<{ user_id: string }>(
      `SELECT user_id FROM event_participants WHERE event_id = $1`,
      [eventId]
    )
  ).map((p) => p.user_id);

  // Only owner or admin can update
  if (event.owner_id !== requesterId && !hasMinimumRole(requesterRole, 'admin')) {
    throw new ForbiddenError('Only the event owner or admin can modify this event');
  }

  // Sprint 3.5.1: stessa guardia di createEvent quando si tenta di
  // pubblicare al feed pubblico. L'owner è sempre `event.owner_id` (non
  // requesterId, perché un admin potrebbe modificare per conto di altri).
  await assertCanPublishPublic(event.owner_id, input.visibility);

  const sets: string[] = [];
  const params: any[] = [];
  let idx = 1;

  const addSet = (column: string, value: any) => {
    if (value !== undefined) {
      sets.push(`${column} = $${idx}`);
      params.push(value);
      idx++;
    }
  };

  addSet('title', input.title);
  addSet('description', input.description);
  addSet('event_date', input.eventDate);
  addSet('start_time', input.startTime);
  addSet('end_time', input.endTime);
  addSet('has_alarm', input.hasAlarm);
  addSet('alarm_datetime', input.alarmDatetime);
  addSet('confirmation_deadline', input.confirmationDeadline);
  if (input.metadata) addSet('metadata', JSON.stringify(input.metadata));
  if (input.recurrenceRule !== undefined) addSet('recurrence_rule', input.recurrenceRule || null);
  if (input.isPrivate !== undefined) addSet('is_private', input.isPrivate);
  if (input.alarmMinutesBefore !== undefined) addSet('alarm_minutes_before', input.alarmMinutesBefore);
  // 047: toggle "gli invitati possono invitare altre persone".
  if (input.allowGuestsToInvite !== undefined) addSet('allow_guests_to_invite', input.allowGuestsToInvite);
  // Sprint 3.5.1: visibility + cover. `visibility` è ENUM, cast esplicito.
  if (input.visibility !== undefined) {
    sets.push(`visibility = $${idx}::event_visibility`);
    params.push(input.visibility);
    idx++;
  }
  if (input.coverAttachmentId !== undefined) addSet('cover_attachment_id', input.coverAttachmentId);

  // 042: location + timezone evento. lat/lng cast esplicito a NUMERIC
  // (zod manda number ma la colonna è NUMERIC(10,7)).
  if (input.locationName !== undefined) addSet('location_name', input.locationName);
  if (input.locationLat !== undefined) {
    sets.push(`location_lat = $${idx}::numeric`);
    params.push(input.locationLat);
    idx++;
  }
  if (input.locationLng !== undefined) {
    sets.push(`location_lng = $${idx}::numeric`);
    params.push(input.locationLng);
    idx++;
  }
  if (input.timezone !== undefined) addSet('timezone', input.timezone);

  // Riarma il promemoria se cambiano orario o anticipo.
  if (input.eventDate !== undefined || input.startTime !== undefined || input.alarmMinutesBefore !== undefined) {
    sets.push(`alarm_sent_at = NULL`);
  }

  // Sprint 3.5.1: aggiornamenti che toccano solo participants o
  // externalLinks sono validi anche se `sets` è vuoto.
  const hasOnlyRelations =
    sets.length === 0 &&
    (input.participants !== undefined || input.externalLinks !== undefined);

  if (sets.length === 0 && !hasOnlyRelations) {
    throw new BadRequestError('No fields to update');
  }

  if (sets.length > 0) {
    sets.push(`updated_at = NOW()`);
    await query(
      `UPDATE events SET ${sets.join(', ')} WHERE id = $${idx}`,
      [...params, eventId]
    );
  }

  // ── Sync participants if provided ──
  if (input.participants !== undefined) {
    // Fetch current participants (to preserve organizer + existing confirmations)
    const existing = await queryMany<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM event_participants WHERE event_id = $1`,
      [eventId]
    );
    const existingIds = new Set(existing.map((p: any) => p.user_id));
    const organizerIds = new Set(existing.filter((p: any) => p.role === 'organizer').map((p: any) => p.user_id));

    // New desired set (always keep organizers)
    const newIds = new Set(input.participants.map((p: any) => p.userId));
    organizerIds.forEach(id => newIds.add(id));

    // Remove participants no longer in the list (skip organizers)
    for (const p of existing) {
      if (p.role !== 'organizer' && !newIds.has(p.user_id)) {
        await query(`DELETE FROM event_participants WHERE event_id = $1 AND user_id = $2`, [eventId, p.user_id]);
      }
    }

    // Add new participants; update the role of existing non-organizer participants
    for (const p of input.participants) {
      if (!existingIds.has(p.userId)) {
        await query(
          `INSERT INTO event_participants (event_id, user_id, role, confirmation)
           VALUES ($1, $2, $3, 'pending')
           ON CONFLICT (event_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [eventId, p.userId, p.role]
        );
      } else if (!organizerIds.has(p.userId)) {
        await query(
          `UPDATE event_participants SET role = $3 WHERE event_id = $1 AND user_id = $2`,
          [eventId, p.userId, p.role]
        );
      }
    }
  }

  // ── Sprint 3.5.1: REPLACE dei link esterni (delete + insert) ──
  // Se l'array è passato, sostituisce interamente il set; se omesso,
  // i link esistenti restano intatti. Atomicità via transaction.
  if (input.externalLinks !== undefined) {
    await transaction(async (client: PoolClient) => {
      await client.query(
        `DELETE FROM event_external_links WHERE event_id = $1`,
        [eventId]
      );
      if (input.externalLinks && input.externalLinks.length > 0) {
        await insertExternalLinks(client, eventId, input.externalLinks);
      }
    });
  }

  syncEventToGCalAsync(eventId, event.owner_id);
  await invalidateEvent(eventId, beforeParticipantIds);
  return getEventById(eventId, requesterId);
}

// ── MOVE (drag & drop) ──

export async function moveEvent(
  eventId: string,
  requesterId: string,
  requesterRole: Role,
  eventDate: string,
  startTime?: string,
  endTime?: string
): Promise<any> {
  const event = await queryOne<EventRow>(
    `SELECT * FROM events WHERE id = $1`,
    [eventId]
  );
  if (!event) throw new NotFoundError('Event not found');

  if (event.owner_id !== requesterId && !hasMinimumRole(requesterRole, 'admin')) {
    throw new ForbiddenError('Only the event owner can move this event');
  }

  await query(
    `UPDATE events SET event_date = $1, start_time = $2, end_time = $3,
            alarm_sent_at = NULL, updated_at = NOW()
     WHERE id = $4`,
    [eventDate, startTime || event.start_time, endTime || event.end_time, eventId]
  );

  syncEventToGCalAsync(eventId, event.owner_id);
  await invalidateEvent(eventId);
  return getEventById(eventId, requesterId);
}

// ── DELETE ──

export async function deleteEvent(
  eventId: string,
  requesterId: string,
  requesterRole: Role
): Promise<void> {
  const event = await queryOne<EventRow>(
    `SELECT * FROM events WHERE id = $1`,
    [eventId]
  );
  if (!event) throw new NotFoundError('Event not found');

  if (event.owner_id !== requesterId && !hasMinimumRole(requesterRole, 'admin')) {
    throw new ForbiddenError('Only the event owner or admin can delete this event');
  }

  // Soft delete: mark as closed + cancelled
  await query(
    `UPDATE events SET closed = true, status = 'cancelled', updated_at = NOW() WHERE id = $1`,
    [eventId]
  );

  // Remove from Google Calendar if synced
  deleteEventFromGCalAsync(event.owner_id, event.gcalendar_event_id);

  await invalidateEvent(eventId);
}

// ── STATUS ──

export async function changeEventStatus(
  eventId: string,
  requesterId: string,
  requesterRole: Role,
  status: string
): Promise<any> {
  const event = await queryOne<EventRow>(
    `SELECT * FROM events WHERE id = $1`,
    [eventId]
  );
  if (!event) throw new NotFoundError('Event not found');

  if (event.owner_id !== requesterId && !hasMinimumRole(requesterRole, 'admin')) {
    throw new ForbiddenError('Only the event owner or admin can change status');
  }

  await query(
    `UPDATE events SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, eventId]
  );

  // Notifica partecipanti in caso di cancellazione o sospensione
  if (status === 'cancelled' || status === 'suspended') {
    const parts = await queryMany<{ user_id: string }>(
      `SELECT user_id FROM event_participants WHERE event_id = $1 AND user_id != $2`,
      [eventId, requesterId]
    );
    if (parts.length > 0) {
      const { createBulkNotifications } = await import('../notifications/notifications.service');
      const { sendPushToUsers } = await import('../../core/notifications/push');
      const ids = parts.map((p: any) => p.user_id);
      const label = status === 'cancelled' ? 'annullato' : 'sospeso';
      await createBulkNotifications(ids, `event_${status}`, `Evento ${label}`, event.title, { eventId });
      setImmediate(() => sendPushToUsers(ids, `Evento ${label}`, event.title, { type: `event_${status}`, eventId, url: '/agenda' }).catch(() => {}));
    }
  }

  await invalidateEvent(eventId);
  return getEventById(eventId, requesterId);
}

// ── CONFIRM PARTICIPATION ──

export async function confirmParticipation(
  eventId: string,
  userId: string,
  confirmation: string
): Promise<any> {
  const participant = await queryOne<{ role: string; confirmation: string }>(
    `SELECT * FROM event_participants WHERE event_id = $1 AND user_id = $2`,
    [eventId, userId]
  );

  if (!participant) throw new NotFoundError('You are not a participant of this event');

  await query(
    `UPDATE event_participants SET confirmation = $1, confirmed_at = NOW()
     WHERE event_id = $2 AND user_id = $3`,
    [confirmation, eventId, userId]
  );

  // Check if all participants have confirmed → auto-confirm event
  if (confirmation === 'accepted') {
    const pendingCount = await queryOne<{ count: string }>(
      `SELECT COUNT(*) as count FROM event_participants
       WHERE event_id = $1 AND confirmation = 'pending'`,
      [eventId]
    );
    if (parseInt(pendingCount?.count || '0', 10) === 0) {
      const updated = await query(
        `UPDATE events SET status = 'confirmed', updated_at = NOW() WHERE id = $1 AND status = 'pending' RETURNING title, owner_id`,
        [eventId]
      );
      // Notifica l'organizzatore che tutti hanno confermato
      if (updated.rowCount && updated.rowCount > 0) {
        const ev = updated.rows[0];
        const { createNotification } = await import('../notifications/notifications.service');
        const { sendPushToUser } = await import('../../core/notifications/push');
        await createNotification({ userId: ev.owner_id, type: 'event_confirmed', title: 'Tutti hanno confermato', body: `"${ev.title}" è ora confermato`, data: { eventId } });
        setImmediate(() => sendPushToUser(ev.owner_id, '✅ Evento confermato', `"${ev.title}" — tutti i partecipanti hanno accettato`, { type: 'event_confirmed', eventId, url: '/agenda' }).catch(() => {}));
      }
    }
  }

  // Un convocato principale ha rifiutato: "chiama" un riservista al suo posto.
  if (
    confirmation === 'declined' &&
    participant.role === 'participant' &&
    participant.confirmation !== 'declined'
  ) {
    const reserve = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM event_participants
       WHERE event_id = $1 AND role = 'reserve' AND confirmation <> 'declined'
       LIMIT 1`,
      [eventId]
    );
    if (reserve) {
      await query(
        `UPDATE event_participants
         SET role = 'participant', confirmation = 'pending', confirmed_at = NULL
         WHERE event_id = $1 AND user_id = $2`,
        [eventId, reserve.user_id]
      );
      const ev = await queryOne<{ title: string }>(`SELECT title FROM events WHERE id = $1`, [eventId]);
      const { createNotification } = await import('../notifications/notifications.service');
      const { sendPushToUser } = await import('../../core/notifications/push');
      await createNotification({
        userId: reserve.user_id,
        type: 'reserve_called',
        title: 'Sei stato chiamato',
        body: `Un posto si è liberato per "${ev?.title}". Confermi?`,
        data: { eventId },
      });
      setImmediate(() => sendPushToUser(
        reserve.user_id,
        'Sei stato chiamato',
        `Un posto si è liberato per "${ev?.title}" — confermi la presenza?`,
        { type: 'reserve_called', eventId, url: '/agenda' }
      ).catch(() => {}));
    }
  }

  return getEventById(eventId, userId);
}

// ── CONVERT EVENT TYPE ──

export async function convertEvent(
  eventId: string,
  requesterId: string,
  requesterRole: Role,
  newType: string,
  startTime?: string,
  endTime?: string
): Promise<any> {
  const event = await queryOne<EventRow>(
    `SELECT * FROM events WHERE id = $1`,
    [eventId]
  );
  if (!event) throw new NotFoundError('Event not found');

  if (event.owner_id !== requesterId && !hasMinimumRole(requesterRole, 'admin')) {
    throw new ForbiddenError('Only the event owner can convert this event');
  }

  if (event.type === newType) {
    throw new BadRequestError('Event is already of this type');
  }

  // For conversion to appointment/commitment, start/end times are required
  const finalStartTime = startTime || event.start_time;
  const finalEndTime = endTime || event.end_time;

  if (newType !== 'reminder' && (!finalStartTime || !finalEndTime)) {
    throw new BadRequestError('startTime and endTime are required for appointments and commitments');
  }

  await query(
    `UPDATE events SET type = $1, start_time = $2, end_time = $3, updated_at = NOW()
     WHERE id = $4`,
    [
      newType,
      newType === 'reminder' ? null : finalStartTime,
      newType === 'reminder' ? null : finalEndTime,
      eventId,
    ]
  );

  await invalidateEvent(eventId);
  return getEventById(eventId, requesterId);
}

// ── PARTICIPANTS ──

export async function addParticipant(
  eventId: string,
  requesterId: string,
  requesterRole: Role,
  targetUserId: string,
  role: string
): Promise<any> {
  const event = await queryOne<EventRow>(
    `SELECT * FROM events WHERE id = $1`,
    [eventId]
  );
  if (!event) throw new NotFoundError('Event not found');

  if (event.owner_id !== requesterId && !hasMinimumRole(requesterRole, 'admin')) {
    throw new ForbiddenError('Only the event owner can add participants');
  }

  // Verify target user exists
  const targetUser = await queryOne(`SELECT id FROM users WHERE id = $1 AND is_active = true`, [targetUserId]);
  if (!targetUser) throw new NotFoundError('User not found');

  await query(
    `INSERT INTO event_participants (event_id, user_id, role, confirmation)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (event_id, user_id) DO NOTHING`,
    [eventId, targetUserId, role]
  );

  await invalidateEvent(eventId);
  return getEventById(eventId, requesterId);
}

export async function removeParticipant(
  eventId: string,
  requesterId: string,
  requesterRole: Role,
  targetUserId: string
): Promise<any> {
  const event = await queryOne<EventRow>(
    `SELECT * FROM events WHERE id = $1`,
    [eventId]
  );
  if (!event) throw new NotFoundError('Event not found');

  if (event.owner_id !== requesterId && !hasMinimumRole(requesterRole, 'admin')) {
    throw new ForbiddenError('Only the event owner can remove participants');
  }

  // Cannot remove the owner
  if (targetUserId === event.owner_id) {
    throw new BadRequestError('Cannot remove the event owner');
  }

  await query(
    `DELETE FROM event_participants WHERE event_id = $1 AND user_id = $2`,
    [eventId, targetUserId]
  );

  await invalidateEvent(eventId, [targetUserId]);
  return getEventById(eventId, requesterId);
}

// ── CALENDAR PERMISSIONS ──

export async function getCalendarPermissions(operatorUserId: string): Promise<any[]> {
  return queryMany(
    `SELECT cp.*, o_viewer.first_name, o_viewer.last_name, o_viewer.email,
            o_viewer.user_id as viewer_user_id
     FROM calendar_permissions cp
     JOIN operators o_owner ON o_owner.id = cp.owner_operator_id
     JOIN operators o_viewer ON o_viewer.id = cp.viewer_operator_id
     WHERE o_owner.user_id = $1`,
    [operatorUserId]
  );
}

export async function grantCalendarPermission(
  ownerUserId: string,
  viewerUserId: string,
  canEdit: boolean
): Promise<void> {
  const owner = await queryOne<{ id: string }>(`SELECT id FROM operators WHERE user_id = $1`, [ownerUserId]);
  const viewer = await queryOne<{ id: string }>(`SELECT id FROM operators WHERE user_id = $1`, [viewerUserId]);

  if (!owner || !viewer) throw new NotFoundError('Operator not found');

  await query(
    `INSERT INTO calendar_permissions (owner_operator_id, viewer_operator_id, can_edit)
     VALUES ($1, $2, $3)
     ON CONFLICT (owner_operator_id, viewer_operator_id)
     DO UPDATE SET can_edit = $3`,
    [owner.id, viewer.id, canEdit]
  );
}

export async function revokeCalendarPermission(
  ownerUserId: string,
  viewerUserId: string
): Promise<void> {
  const owner = await queryOne<{ id: string }>(`SELECT id FROM operators WHERE user_id = $1`, [ownerUserId]);
  const viewer = await queryOne<{ id: string }>(`SELECT id FROM operators WHERE user_id = $1`, [viewerUserId]);

  if (!owner || !viewer) throw new NotFoundError('Operator not found');

  await query(
    `DELETE FROM calendar_permissions WHERE owner_operator_id = $1 AND viewer_operator_id = $2`,
    [owner.id, viewer.id]
  );
}

// ── ATTACHMENTS ──

// MIME types accettati: foto da fotocamera/galleria (jpeg/png/heic/heif/webp)
// e documenti PDF. Office/Excel sono esclusi: meettoo è consumer, non CRM.
const ACCEPTED_ATTACHMENT_MIMES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
  'application/pdf',
]);

export interface EventAttachment {
  id: string;
  event_id: string;
  file_name: string;
  file_size: number | null;
  mime_type: string | null;
  uploaded_by: string | null;
  uploaded_by_name: string | null;
  created_at: string;
}

interface AttachmentDbRow {
  id: string;
  event_id: string;
  file_name: string;
  file_path: string;
  file_size: number | null;
  mime_type: string | null;
  uploaded_by: string | null;
  created_at: string;
}

/**
 * Verifica che l'utente possa accedere agli allegati dell'evento.
 * Riusa la logica di getEventById (owner/partecipante/creator/admin/operator
 * per eventi non privati). Solleva ForbiddenError / NotFoundError.
 */
async function assertEventAccess(eventId: string, userId: string): Promise<void> {
  await getEventById(eventId, userId);
}

/**
 * Carica uno o più allegati per un evento. Il chiamante deve essere
 * owner o partecipante (vedi assertEventAccess).
 *
 * Filtra i MIME non consentiti restituendo 400. Se nessun file passa la
 * validazione, la lista risultante è vuota ma la chiamata non fallisce
 * a meno che almeno un file abbia un MIME rifiutato (in quel caso 400).
 */
export async function uploadAttachments(
  eventId: string,
  userId: string,
  parts: AsyncIterableIterator<any>
): Promise<EventAttachment[]> {
  await assertEventAccess(eventId, userId);

  const saved: AttachmentDbRow[] = [];
  // Tieni traccia dei file salvati a disco per poterli rimuovere se la
  // transazione DB fallisce o se un file successivo ha un MIME non valido.
  const savedPaths: string[] = [];

  try {
    for await (const part of parts) {
      if (part.type !== 'file') continue;

      const mime = (part.mimetype || '').toLowerCase();
      if (!ACCEPTED_ATTACHMENT_MIMES.has(mime)) {
        // Drena lo stream per evitare leak prima di sollevare l'errore.
        part.file.resume();
        throw new BadRequestError(
          `Unsupported file type: ${mime || 'unknown'}. Allowed: images (jpeg/png/heic/heif/webp) and PDF.`
        );
      }

      const uploaded = await saveUploadedFile(part, `events/${eventId}`);
      savedPaths.push(uploaded.filePath);

      const inserted = await queryOne<AttachmentDbRow>(
        `INSERT INTO event_attachments
           (event_id, file_name, file_path, file_size, mime_type, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, event_id, file_name, file_path, file_size, mime_type, uploaded_by, created_at`,
        [eventId, uploaded.originalName, uploaded.filePath, uploaded.size, uploaded.mimeType, userId]
      );

      if (inserted) saved.push(inserted);
    }
  } catch (err) {
    // Best-effort cleanup dei file scritti su disco se qualcosa esplode.
    for (const p of savedPaths) {
      deleteUploadedFile(p);
    }
    throw err;
  }

  if (saved.length === 0) {
    throw new BadRequestError('No files were uploaded');
  }

  // Arricchisci con uploaded_by_name in una singola query
  return enrichAttachments(saved);
}

/**
 * Lista gli allegati di un evento (più recenti prima). NON espone file_path.
 */
export async function listAttachments(
  eventId: string,
  userId: string
): Promise<EventAttachment[]> {
  await assertEventAccess(eventId, userId);

  const rows = await queryMany<AttachmentDbRow>(
    `SELECT id, event_id, file_name, file_path, file_size, mime_type, uploaded_by, created_at
     FROM event_attachments
     WHERE event_id = $1
     ORDER BY created_at DESC`,
    [eventId]
  );

  return enrichAttachments(rows);
}

/**
 * Restituisce i metadati e il path filesystem di un allegato pronto per
 * essere streamato come download. Il controller userà filePath con
 * getAbsolutePath() per costruire il ReadStream.
 */
export async function getAttachmentForDownload(
  eventId: string,
  attachmentId: string,
  userId: string
): Promise<{ filePath: string; fileName: string; mimeType: string; absolutePath: string }> {
  await assertEventAccess(eventId, userId);

  const row = await queryOne<AttachmentDbRow>(
    `SELECT id, event_id, file_name, file_path, file_size, mime_type, uploaded_by, created_at
     FROM event_attachments
     WHERE id = $1`,
    [attachmentId]
  );
  if (!row) throw new NotFoundError('Attachment not found');
  // Difesa in profondità: l'attachment deve appartenere all'evento del path.
  if (row.event_id !== eventId) throw new NotFoundError('Attachment not found');

  const absolutePath = getAbsolutePath(row.file_path);
  if (!existsSync(absolutePath)) {
    throw new NotFoundError('Attachment file is missing on the server');
  }

  return {
    filePath: row.file_path,
    fileName: row.file_name,
    mimeType: row.mime_type || 'application/octet-stream',
    absolutePath,
  };
}

/**
 * Cancella un allegato. Autorizzato: owner dell'evento OR chi ha caricato
 * l'allegato (uploaded_by === userId). Admin/owner del sistema passano via
 * hasMinimumRole. Rimuove la riga DB e il file dal filesystem.
 */
export async function deleteAttachment(
  eventId: string,
  attachmentId: string,
  userId: string,
  userRole: Role
): Promise<void> {
  const attachment = await queryOne<AttachmentDbRow>(
    `SELECT id, event_id, file_name, file_path, file_size, mime_type, uploaded_by, created_at
     FROM event_attachments
     WHERE id = $1`,
    [attachmentId]
  );
  if (!attachment) throw new NotFoundError('Attachment not found');
  if (attachment.event_id !== eventId) throw new NotFoundError('Attachment not found');

  const event = await queryOne<{ owner_id: string }>(
    `SELECT owner_id FROM events WHERE id = $1`,
    [eventId]
  );
  if (!event) throw new NotFoundError('Event not found');

  const isOwner = event.owner_id === userId;
  const isUploader = attachment.uploaded_by === userId;
  const isAdmin = hasMinimumRole(userRole, 'admin');

  if (!isOwner && !isUploader && !isAdmin) {
    throw new ForbiddenError('Only the event owner or the uploader can delete this attachment');
  }

  await query(`DELETE FROM event_attachments WHERE id = $1`, [attachmentId]);
  deleteUploadedFile(attachment.file_path);
}

/**
 * Lookup dei nomi degli uploader in batch. Restituisce gli allegati nel
 * formato pubblico (senza file_path).
 */
async function enrichAttachments(rows: AttachmentDbRow[]): Promise<EventAttachment[]> {
  if (rows.length === 0) return [];

  const uploaderIds = Array.from(
    new Set(rows.map((r) => r.uploaded_by).filter((id): id is string => !!id))
  );

  const users = uploaderIds.length > 0
    ? await queryMany<{ id: string; display_name: string }>(
        `SELECT id, COALESCE(name, username) as display_name
         FROM users WHERE id = ANY($1)`,
        [uploaderIds]
      )
    : [];
  const nameById = new Map(users.map((u) => [u.id, u.display_name]));

  return rows.map((r) => ({
    id: r.id,
    event_id: r.event_id,
    file_name: r.file_name,
    file_size: r.file_size,
    mime_type: r.mime_type,
    uploaded_by: r.uploaded_by,
    uploaded_by_name: r.uploaded_by ? nameById.get(r.uploaded_by) ?? null : null,
    created_at: r.created_at,
  }));
}

// ── DELETE SINGLE OCCURRENCE ──

/**
 * Adds a date to recurrence_exceptions, "hiding" that occurrence.
 */
export async function deleteOccurrence(
  eventId: string,
  occurrenceDate: string,
  requesterId: string,
  requesterRole: Role
): Promise<void> {
  const event = await queryOne<EventRow & { recurrence_exceptions: string[] }>(
    `SELECT id, owner_id, recurrence_rule, recurrence_exceptions FROM events WHERE id = $1`,
    [eventId]
  );
  if (!event) throw new NotFoundError('Event not found');
  if (!event.recurrence_rule) throw new BadRequestError('Event is not recurring');
  if (event.owner_id !== requesterId && !hasMinimumRole(requesterRole, 'admin')) {
    throw new ForbiddenError('Only the event owner can modify this event');
  }

  const exceptions: string[] = Array.isArray(event.recurrence_exceptions)
    ? event.recurrence_exceptions
    : [];

  if (!exceptions.includes(occurrenceDate)) {
    exceptions.push(occurrenceDate);
    await query(
      `UPDATE events SET recurrence_exceptions = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify(exceptions), eventId]
    );
    await invalidateEvent(eventId);
  }
}
