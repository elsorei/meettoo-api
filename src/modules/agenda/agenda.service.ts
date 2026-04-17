import { queryOne, queryMany, query, transaction } from '../../shared/db';
import { PoolClient } from 'pg';
import { RRule } from 'rrule';
import { NotFoundError, ForbiddenError, BadRequestError } from '../../core/errors';
import { CreateEventInput, UpdateEventInput, ListEventsQuery } from './agenda.schema';
import { Role, hasMinimumRole } from '../../core/auth/roles';
import { syncEventToGCalAsync, deleteEventFromGCalAsync } from './gcalendar.hooks';
import { triggerNewEvent } from '../../core/notifications/triggers';

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
}

interface AttachmentRow {
  id: string;
  file_name: string;
  file_path: string;
  file_size: number | null;
  mime_type: string | null;
  created_at: string;
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

  const eventId = await transaction(async (client: PoolClient) => {
    // Insert event (con created_by_id se assegnato da un altro operatore)
    const eventResult = await client.query(
      `INSERT INTO events (type, title, description, event_date, start_time, end_time,
                           has_alarm, alarm_datetime, confirmation_deadline, owner_id, metadata,
                           recurrence_rule, created_by_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
        input.confirmationDeadline || null,
        ownerId,
        JSON.stringify(input.metadata || {}),
        input.recurrenceRule || null,
        createdById,
      ]
    );

    const newId = eventResult.rows[0].id;

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

    return newId as string;
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

  return getEventById(eventId, ownerId);
}

// ── READ ──

export async function getEventById(eventId: string, requesterId: string): Promise<any> {
  const event = await queryOne<EventRow & { owner_name: string; owner_photo: string | null; created_by_name: string | null; created_by_photo: string | null }>(
    `SELECT e.*, e.event_date::text as event_date,
            COALESCE(o.first_name || ' ' || o.last_name, c.business_name, u.username) as owner_name,
            o.photo as owner_photo,
            COALESCE(ocb.first_name || ' ' || ocb.last_name, ucb.username) as created_by_name,
            ocb.photo as created_by_photo
     FROM events e
     JOIN users u ON u.id = e.owner_id
     LEFT JOIN operators o ON o.user_id = e.owner_id
     LEFT JOIN clients c ON c.user_id = e.owner_id
     LEFT JOIN users ucb ON ucb.id = e.created_by_id
     LEFT JOIN operators ocb ON ocb.user_id = e.created_by_id
     WHERE e.id = $1`,
    [eventId]
  );

  if (!event) throw new NotFoundError('Event not found');

  // Check access: must be owner or participant
  const isParticipant = await queryOne(
    `SELECT 1 FROM event_participants WHERE event_id = $1 AND user_id = $2`,
    [eventId, requesterId]
  );

  // Also check if requester is admin/owner or has calendar permission
  const requester = await queryOne<{ role: Role }>(
    `SELECT role FROM users WHERE id = $1`,
    [requesterId]
  );

  const isCreator = (event as any).created_by_id === requesterId;

  if (!isParticipant && event.owner_id !== requesterId && !isCreator && !hasMinimumRole(requester?.role || 'client', 'admin')) {
    // Operatori possono vedere le agende dei colleghi senza permessi espliciti
    if (requester?.role !== 'operator') {
      throw new ForbiddenError('You do not have access to this event');
    }
  }

  // Fetch participants with user info
  const participants = await queryMany<ParticipantRow>(
    `SELECT ep.id, ep.event_id, ep.user_id, ep.role, ep.confirmation, ep.confirmed_at,
            u.username, u.role as user_role,
            COALESCE(
              o.first_name || ' ' || o.last_name,
              c.business_name,
              u.username
            ) as display_name
     FROM event_participants ep
     JOIN users u ON u.id = ep.user_id
     LEFT JOIN operators o ON o.user_id = u.id
     LEFT JOIN clients c ON c.user_id = u.id
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

  return {
    ...event,
    participants,
    attachments,
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
            COALESCE(
              o.first_name || ' ' || o.last_name,
              c.business_name,
              owner_u.username
            ) as owner_name,
            (SELECT COUNT(*) FROM event_participants WHERE event_id = e.id) as participant_count,
            (SELECT COUNT(*) FROM event_attachments WHERE event_id = e.id) as attachment_count,
            (SELECT ep_me.confirmation FROM event_participants ep_me WHERE ep_me.event_id = e.id AND ep_me.user_id = $${paramIndex}) as my_confirmation
     FROM events e
     LEFT JOIN users owner_u ON owner_u.id = e.owner_id
     LEFT JOIN operators o ON o.user_id = e.owner_id
     LEFT JOIN clients c ON c.user_id = e.owner_id
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

  // Tutti gli operatori/admin/owner possono vedere le agende dei colleghi.
  // Solo i client non possono accedere ai calendari degli operatori.
  if (operatorId && operatorId !== requesterId && requesterRole === 'client') {
    throw new ForbiddenError('No permission to view this calendar');
  }

  // Quando si guarda il calendario di un altro operatore, gli impegni e i
  // promemoria vengono mascherati per privacy.
  const isViewingOther = !!(operatorId && operatorId !== requesterId);

  const rawEvents = await queryMany(
    `SELECT e.id, e.type, e.title, e.description,
            e.event_date::text, e.start_time::text, e.end_time::text,
            e.status, e.has_alarm, e.alarm_datetime, e.closed, e.owner_id,
            e.recurrence_rule, e.recurrence_exceptions,
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
            COALESCE(o.first_name || ' ' || o.last_name, c.business_name, u.username) as display_name,
            u.role as user_role
     FROM event_participants ep
     JOIN users u ON u.id = ep.user_id
     LEFT JOIN operators o ON o.user_id = u.id
     LEFT JOIN clients c ON c.user_id = u.id
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

    // ── Privacy masking quando si guarda il calendario di un altro operatore ──
    if (isViewingOther) {
      // Promemoria: nascosti del tutto (sono note personali)
      if (e.type === 'reminder') return null;

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

  // Only owner or admin can update
  if (event.owner_id !== requesterId && !hasMinimumRole(requesterRole, 'admin')) {
    throw new ForbiddenError('Only the event owner or admin can modify this event');
  }

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

  if (sets.length === 0) throw new BadRequestError('No fields to update');

  sets.push(`updated_at = NOW()`);

  await query(
    `UPDATE events SET ${sets.join(', ')} WHERE id = $${idx}`,
    [...params, eventId]
  );

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

    // Add new participants not yet in the table
    for (const p of input.participants) {
      if (!existingIds.has(p.userId)) {
        await query(
          `INSERT INTO event_participants (event_id, user_id, role, confirmation)
           VALUES ($1, $2, $3, 'pending')
           ON CONFLICT (event_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [eventId, p.userId, p.role]
        );
      }
    }
  }

  syncEventToGCalAsync(eventId, event.owner_id);
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
    `UPDATE events SET event_date = $1, start_time = $2, end_time = $3, updated_at = NOW()
     WHERE id = $4`,
    [eventDate, startTime || event.start_time, endTime || event.end_time, eventId]
  );

  syncEventToGCalAsync(eventId, event.owner_id);
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

  return getEventById(eventId, requesterId);
}

// ── CONFIRM PARTICIPATION ──

export async function confirmParticipation(
  eventId: string,
  userId: string,
  confirmation: string
): Promise<any> {
  const participant = await queryOne(
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
        const confirmerName = await queryOne<{ name: string }>(
          `SELECT COALESCE(o.first_name || ' ' || o.last_name, c.business_name, u.username) as name
           FROM users u LEFT JOIN operators o ON o.user_id = u.id LEFT JOIN clients c ON c.user_id = u.id
           WHERE u.id = $1`, [userId]
        );
        const { createNotification } = await import('../notifications/notifications.service');
        const { sendPushToUser } = await import('../../core/notifications/push');
        await createNotification({ userId: ev.owner_id, type: 'event_confirmed', title: 'Tutti hanno confermato', body: `"${ev.title}" è ora confermato`, data: { eventId } });
        setImmediate(() => sendPushToUser(ev.owner_id, '✅ Evento confermato', `"${ev.title}" — tutti i partecipanti hanno accettato`, { type: 'event_confirmed', eventId, url: '/agenda' }).catch(() => {}));
      }
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
  }
}
