import { google, calendar_v3 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { getGCalConfig } from '../../config/google-calendar';
import { queryOne, queryMany, query } from '../../shared/db';
import { NotFoundError, BadRequestError } from '../../core/errors';

// ── Types ──

interface OperatorTokens {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  token_type: string;
}

interface EventRow {
  id: string;
  type: string;
  title: string;
  description: string | null;
  event_date: string;
  start_time: string | null;
  end_time: string | null;
  status: string;
  gcalendar_event_id: string | null;
  owner_id: string;
}

interface SyncResult {
  imported: number;
  exported: number;
  updated: number;
  errors: string[];
}

// ── OAuth2 Client Factory ──

function createOAuth2Client(): OAuth2Client {
  const config = getGCalConfig();
  if (!config) throw new BadRequestError('Google Calendar is not configured');
  return new google.auth.OAuth2(config.clientId, config.clientSecret, config.redirectUri);
}

async function getAuthenticatedClient(operatorUserId: string): Promise<{ oauth2: OAuth2Client; calendar: calendar_v3.Calendar }> {
  const operator = await queryOne<{ gcalendar_tokens: OperatorTokens | null }>(
    `SELECT gcalendar_tokens FROM operators WHERE user_id = $1`,
    [operatorUserId]
  );

  if (!operator?.gcalendar_tokens) {
    throw new BadRequestError('Google Calendar not connected. Please connect first.');
  }

  const oauth2 = createOAuth2Client();
  oauth2.setCredentials(operator.gcalendar_tokens);

  // Handle token refresh
  oauth2.on('tokens', async (tokens) => {
    const merged = { ...operator.gcalendar_tokens, ...tokens };
    await query(
      `UPDATE operators SET gcalendar_tokens = $1, updated_at = NOW() WHERE user_id = $2`,
      [JSON.stringify(merged), operatorUserId]
    );
  });

  const calendar = google.calendar({ version: 'v3', auth: oauth2 });
  return { oauth2, calendar };
}

// ── OAuth2 Flow ──

/**
 * Generate the Google OAuth2 authorization URL.
 * The operator clicks this link to authorize our app.
 */
export function getAuthUrl(state?: string): string {
  const config = getGCalConfig();
  if (!config) throw new BadRequestError('Google Calendar is not configured');

  const oauth2 = createOAuth2Client();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: config.scopes,
    state: state || '',
  });
}

/**
 * Exchange the authorization code for tokens and store them.
 */
export async function handleCallback(
  operatorUserId: string,
  code: string
): Promise<void> {
  const oauth2 = createOAuth2Client();
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    throw new BadRequestError('No refresh token received. Please revoke access and try again.');
  }

  await query(
    `UPDATE operators SET gcalendar_tokens = $1, updated_at = NOW() WHERE user_id = $2`,
    [JSON.stringify(tokens), operatorUserId]
  );
}

/**
 * Disconnect Google Calendar (remove stored tokens).
 */
export async function disconnect(operatorUserId: string): Promise<void> {
  const operator = await queryOne<{ gcalendar_tokens: OperatorTokens | null }>(
    `SELECT gcalendar_tokens FROM operators WHERE user_id = $1`,
    [operatorUserId]
  );

  if (operator?.gcalendar_tokens) {
    try {
      const oauth2 = createOAuth2Client();
      oauth2.setCredentials(operator.gcalendar_tokens);
      await oauth2.revokeCredentials();
    } catch {
      // Ignore revocation errors - just clear locally
    }
  }

  await query(
    `UPDATE operators SET gcalendar_tokens = NULL, updated_at = NOW() WHERE user_id = $1`,
    [operatorUserId]
  );

  // Clear gcalendar_event_id from all events owned by this user
  await query(
    `UPDATE events SET gcalendar_event_id = NULL, gcalendar_synced_at = NULL
     WHERE owner_id = $1 AND gcalendar_event_id IS NOT NULL`,
    [operatorUserId]
  );
}

/**
 * Check if an operator has connected Google Calendar.
 */
export async function isConnected(operatorUserId: string): Promise<boolean> {
  const row = await queryOne<{ gcalendar_tokens: any }>(
    `SELECT gcalendar_tokens FROM operators WHERE user_id = $1`,
    [operatorUserId]
  );
  return !!row?.gcalendar_tokens;
}

// ── Event Sync: Studio REI → Google Calendar ──

/**
 * Export a single event to Google Calendar.
 */
export async function exportEvent(
  operatorUserId: string,
  eventId: string
): Promise<string> {
  const event = await queryOne<EventRow>(
    `SELECT e.*, e.event_date::text as event_date
     FROM events e WHERE e.id = $1`,
    [eventId]
  );
  if (!event) throw new NotFoundError('Event not found');

  const { calendar } = await getAuthenticatedClient(operatorUserId);
  const gcalEvent = toGCalEvent(event);

  if (event.gcalendar_event_id) {
    // Update existing
    await calendar.events.update({
      calendarId: 'primary',
      eventId: event.gcalendar_event_id,
      requestBody: gcalEvent,
    });
    await query(
      `UPDATE events SET gcalendar_synced_at = NOW() WHERE id = $1`,
      [eventId]
    );
    return event.gcalendar_event_id;
  } else {
    // Create new
    const res = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: gcalEvent,
    });
    const gcalId = res.data.id!;
    await query(
      `UPDATE events SET gcalendar_event_id = $1, gcalendar_synced_at = NOW() WHERE id = $2`,
      [gcalId, eventId]
    );
    return gcalId;
  }
}

/**
 * Delete an event from Google Calendar.
 */
export async function deleteGCalEvent(
  operatorUserId: string,
  gcalEventId: string
): Promise<void> {
  try {
    const { calendar } = await getAuthenticatedClient(operatorUserId);
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: gcalEventId,
    });
  } catch (err: any) {
    // 410 Gone = already deleted, that's fine
    if (err?.code !== 410) throw err;
  }
}

// ── Event Sync: Google Calendar → Studio REI ──

/**
 * Import events from Google Calendar into Studio REI.
 * Only imports events in the specified date range that don't already exist.
 */
export async function importEvents(
  operatorUserId: string,
  from: string,
  to: string
): Promise<{ imported: number; skipped: number }> {
  const { calendar } = await getAuthenticatedClient(operatorUserId);

  const res = await calendar.events.list({
    calendarId: 'primary',
    timeMin: `${from}T00:00:00Z`,
    timeMax: `${to}T23:59:59Z`,
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 250,
  });

  const gcalEvents = res.data.items || [];
  let imported = 0;
  let skipped = 0;

  for (const gcalEvt of gcalEvents) {
    if (!gcalEvt.id || !gcalEvt.summary) {
      skipped++;
      continue;
    }

    // Check if already imported
    const existing = await queryOne(
      `SELECT id FROM events WHERE gcalendar_event_id = $1`,
      [gcalEvt.id]
    );

    if (existing) {
      skipped++;
      continue;
    }

    const { date, startTime, endTime, allDay } = parseGCalDateTime(gcalEvt);

    if (!date) {
      skipped++;
      continue;
    }

    await query(
      `INSERT INTO events (type, title, description, event_date, start_time, end_time,
                           status, owner_id, gcalendar_event_id, gcalendar_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', $7, $8, NOW())`,
      [
        allDay ? 'reminder' : 'commitment',
        gcalEvt.summary,
        gcalEvt.description || null,
        date,
        startTime,
        endTime,
        operatorUserId,
        gcalEvt.id,
      ]
    );

    // Add owner as organizer participant
    const newEvent = await queryOne<{ id: string }>(
      `SELECT id FROM events WHERE gcalendar_event_id = $1`,
      [gcalEvt.id]
    );
    if (newEvent) {
      await query(
        `INSERT INTO event_participants (event_id, user_id, role, confirmation, confirmed_at)
         VALUES ($1, $2, 'organizer', 'accepted', NOW())`,
        [newEvent.id, operatorUserId]
      );
    }

    imported++;
  }

  return { imported, skipped };
}

/**
 * Full bidirectional sync:
 * 1. Export local events that aren't synced yet
 * 2. Import Google events that don't exist locally
 * 3. Update local events whose Google counterpart changed
 */
export async function fullSync(
  operatorUserId: string,
  from: string,
  to: string
): Promise<SyncResult> {
  const result: SyncResult = { imported: 0, exported: 0, updated: 0, errors: [] };
  const { calendar } = await getAuthenticatedClient(operatorUserId);

  // 1. Export unsynced local events
  const unsyncedLocal = await queryMany<EventRow>(
    `SELECT e.*, e.event_date::text as event_date FROM events e
     WHERE e.owner_id = $1
       AND e.gcalendar_event_id IS NULL
       AND e.closed = false
       AND e.event_date >= $2
       AND e.event_date <= $3
       AND e.type IN ('appointment', 'commitment')`,
    [operatorUserId, from, to]
  );

  for (const evt of unsyncedLocal) {
    try {
      const gcalEvent = toGCalEvent(evt);
      const res = await calendar.events.insert({
        calendarId: 'primary',
        requestBody: gcalEvent,
      });
      await query(
        `UPDATE events SET gcalendar_event_id = $1, gcalendar_synced_at = NOW() WHERE id = $2`,
        [res.data.id, evt.id]
      );
      result.exported++;
    } catch (err: any) {
      result.errors.push(`Export failed for event ${evt.id}: ${err.message}`);
    }
  }

  // 2. Import from Google Calendar
  try {
    const importResult = await importEvents(operatorUserId, from, to);
    result.imported = importResult.imported;
  } catch (err: any) {
    result.errors.push(`Import failed: ${err.message}`);
  }

  // 3. Update already-synced events from Google
  const syncedLocal = await queryMany<EventRow>(
    `SELECT e.*, e.event_date::text as event_date FROM events e
     WHERE e.owner_id = $1
       AND e.gcalendar_event_id IS NOT NULL
       AND e.closed = false
       AND e.event_date >= $2
       AND e.event_date <= $3`,
    [operatorUserId, from, to]
  );

  for (const evt of syncedLocal) {
    try {
      const res = await calendar.events.get({
        calendarId: 'primary',
        eventId: evt.gcalendar_event_id!,
      });

      const gcalEvt = res.data;
      if (!gcalEvt || gcalEvt.status === 'cancelled') {
        // Event was deleted on Google side
        await query(
          `UPDATE events SET status = 'cancelled', closed = true, updated_at = NOW() WHERE id = $1`,
          [evt.id]
        );
        result.updated++;
        continue;
      }

      // Check if Google version is newer
      const gcalUpdated = gcalEvt.updated ? new Date(gcalEvt.updated) : null;
      const localUpdated = new Date(evt.event_date);

      if (gcalUpdated && gcalEvt.summary) {
        const { date, startTime, endTime } = parseGCalDateTime(gcalEvt);
        if (date) {
          await query(
            `UPDATE events SET title = $1, description = $2, event_date = $3,
                    start_time = $4, end_time = $5, gcalendar_synced_at = NOW(), updated_at = NOW()
             WHERE id = $6`,
            [gcalEvt.summary, gcalEvt.description || null, date, startTime, endTime, evt.id]
          );
          result.updated++;
        }
      }
    } catch (err: any) {
      if (err?.code === 404) {
        // Event deleted on Google side
        await query(
          `UPDATE events SET gcalendar_event_id = NULL, gcalendar_synced_at = NULL WHERE id = $1`,
          [evt.id]
        );
      } else {
        result.errors.push(`Update check failed for event ${evt.id}: ${err.message}`);
      }
    }
  }

  return result;
}

// ── Helpers ──

/**
 * Convert a Studio REI event to a Google Calendar event resource.
 */
function toGCalEvent(event: EventRow): calendar_v3.Schema$Event {
  const statusMap: Record<string, string> = {
    pending: 'tentative',
    confirmed: 'confirmed',
    cancelled: 'cancelled',
    suspended: 'tentative',
    completed: 'confirmed',
  };

  if (event.start_time && event.end_time) {
    return {
      summary: event.title,
      description: event.description || undefined,
      start: {
        dateTime: `${event.event_date}T${event.start_time}`,
        timeZone: 'Europe/Rome',
      },
      end: {
        dateTime: `${event.event_date}T${event.end_time}`,
        timeZone: 'Europe/Rome',
      },
      status: statusMap[event.status] || 'tentative',
      extendedProperties: {
        private: {
          studiorei_id: event.id,
          studiorei_type: event.type,
        },
      },
    };
  }

  // All-day event (reminders)
  return {
    summary: event.title,
    description: event.description || undefined,
    start: { date: event.event_date },
    end: { date: event.event_date },
    status: statusMap[event.status] || 'tentative',
    extendedProperties: {
      private: {
        studiorei_id: event.id,
        studiorei_type: event.type,
      },
    },
  };
}

/**
 * Parse Google Calendar event datetime into our format.
 */
function parseGCalDateTime(gcalEvt: calendar_v3.Schema$Event): {
  date: string | null;
  startTime: string | null;
  endTime: string | null;
  allDay: boolean;
} {
  if (gcalEvt.start?.date) {
    // All-day event
    return {
      date: gcalEvt.start.date,
      startTime: null,
      endTime: null,
      allDay: true,
    };
  }

  if (gcalEvt.start?.dateTime && gcalEvt.end?.dateTime) {
    const startDT = new Date(gcalEvt.start.dateTime);
    const endDT = new Date(gcalEvt.end.dateTime);

    const date = startDT.toISOString().split('T')[0];
    const startTime = startDT.toTimeString().slice(0, 8); // HH:MM:SS
    const endTime = endDT.toTimeString().slice(0, 8);

    return { date, startTime, endTime, allDay: false };
  }

  return { date: null, startTime: null, endTime: null, allDay: false };
}
