import { query, queryOne } from '../../shared/db';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../core/errors';
import type { IceServer, VideoRoomDTO } from './video.schema';

// ── ICE servers (STUN + TURN) ─────────────────────────────────────────
// In prod sostituire i TURN free con un server dedicato via env
// TURN_URL / TURN_USERNAME / TURN_CREDENTIAL.
// Metered.ca free tier: 50GB/mese — sufficiente per testing.
export function getIceServers(): IceServer[] {
  const stun: IceServer = { urls: 'stun:stun.l.google.com:19302' };

  const { TURN_URL, TURN_USERNAME, TURN_CREDENTIAL } = process.env;
  if (TURN_URL && TURN_USERNAME && TURN_CREDENTIAL) {
    return [
      stun,
      { urls: TURN_URL, username: TURN_USERNAME, credential: TURN_CREDENTIAL },
    ];
  }

  return [
    stun,
    { urls: 'turn:openrelay.metered.ca:80',  username: 'openrelayproject', credential: 'openrelayproject' },
    { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  ];
}

// ── Tipi interni ──────────────────────────────────────────────────────

interface VideoRoomRow {
  id: string;
  event_id: string;
  host_user_id: string;
  status: 'pending' | 'active' | 'ended';
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

interface EventForAuthRow {
  id: string;
  owner_id: string;
  visibility: string;
}

function toDTO(row: VideoRoomRow): VideoRoomDTO {
  return {
    id: row.id,
    event_id: row.event_id,
    host_user_id: row.host_user_id,
    status: row.status,
    started_at: row.started_at,
    ended_at: row.ended_at,
    created_at: row.created_at,
  };
}

// ── Autorizzazione consumer ───────────────────────────────────────────
// Un utente può entrare nella stanza video di un evento se:
//   - è l'owner dell'evento;
//   - è organizer del gruppo partecipanti;
//   - è partecipante con confirmation = 'accepted';
//   - (solo per visibility = 'public_open') è autenticato.
// Per public_view il join NON è permesso: la visibility public_view è "vetrina",
// la videochiamata richiede invito o accettazione.

export async function assertCanJoinEvent(eventId: string, userId: string): Promise<void> {
  const event = await queryOne<EventForAuthRow>(
    `SELECT id, owner_id, visibility::text AS visibility
       FROM events
      WHERE id = $1`,
    [eventId]
  );
  if (!event) throw new NotFoundError('Evento non trovato');

  if (event.owner_id === userId) return;

  // public_open: chiunque autenticato entra in videochiamata.
  if (event.visibility === 'public_open') return;

  const participant = await queryOne<{ role: string; confirmation: string }>(
    `SELECT role, confirmation
       FROM event_participants
      WHERE event_id = $1 AND user_id = $2`,
    [eventId, userId]
  );

  if (!participant) {
    throw new ForbiddenError('Non sei autorizzato a partecipare a questa videochiamata');
  }
  if (participant.role === 'organizer') return;
  if (participant.confirmation === 'accepted') return;

  throw new ForbiddenError(
    'Devi accettare l\'invito all\'evento prima di entrare in videochiamata'
  );
}

export async function assertCanJoinRoom(roomId: string, userId: string): Promise<void> {
  const room = await queryOne<{ event_id: string; status: string }>(
    `SELECT event_id, status FROM video_rooms WHERE id = $1`,
    [roomId]
  );
  if (!room) throw new NotFoundError('Stanza video non trovata');
  if (room.status === 'ended') {
    throw new BadRequestError('La videochiamata è terminata');
  }
  await assertCanJoinEvent(room.event_id, userId);
}

// ── Lookup ────────────────────────────────────────────────────────────

export async function findRoomByEvent(eventId: string): Promise<VideoRoomDTO | null> {
  const row = await queryOne<VideoRoomRow>(
    `SELECT id, event_id, host_user_id, status, started_at, ended_at, created_at
       FROM video_rooms WHERE event_id = $1`,
    [eventId]
  );
  return row ? toDTO(row) : null;
}

export async function getRoom(roomId: string): Promise<VideoRoomDTO> {
  const row = await queryOne<VideoRoomRow>(
    `SELECT id, event_id, host_user_id, status, started_at, ended_at, created_at
       FROM video_rooms WHERE id = $1`,
    [roomId]
  );
  if (!row) throw new NotFoundError('Stanza video non trovata');
  return toDTO(row);
}

// ── Create / End ──────────────────────────────────────────────────────

/**
 * Crea la stanza per l'evento. Se esiste già una stanza non terminata
 * la ritorna invariata (idempotenza per il client che apre la videochiamata).
 * Se esiste ma è 'ended', la riapre (host nuovo, status 'pending').
 */
export async function createOrGetRoom(eventId: string, hostUserId: string): Promise<VideoRoomDTO> {
  await assertCanJoinEvent(eventId, hostUserId);

  const existing = await findRoomByEvent(eventId);
  if (existing && existing.status !== 'ended') return existing;

  if (existing && existing.status === 'ended') {
    const reopened = await queryOne<VideoRoomRow>(
      `UPDATE video_rooms
          SET host_user_id = $1, status = 'pending',
              started_at = NULL, ended_at = NULL
        WHERE id = $2
        RETURNING id, event_id, host_user_id, status, started_at, ended_at, created_at`,
      [hostUserId, existing.id]
    );
    if (!reopened) throw new NotFoundError('Stanza video non trovata');
    return toDTO(reopened);
  }

  const row = await queryOne<VideoRoomRow>(
    `INSERT INTO video_rooms (event_id, host_user_id, status)
     VALUES ($1, $2, 'pending')
     RETURNING id, event_id, host_user_id, status, started_at, ended_at, created_at`,
    [eventId, hostUserId]
  );
  if (!row) throw new BadRequestError('Impossibile creare la stanza video');
  return toDTO(row);
}

export async function endRoom(roomId: string, requesterId: string): Promise<void> {
  const row = await queryOne<{ host_user_id: string; status: string }>(
    `SELECT host_user_id, status FROM video_rooms WHERE id = $1`,
    [roomId]
  );
  if (!row) throw new NotFoundError('Stanza video non trovata');
  if (row.host_user_id !== requesterId) {
    throw new ForbiddenError('Solo l\'host può chiudere la videochiamata');
  }
  if (row.status === 'ended') return;

  await query(
    `UPDATE video_rooms
        SET status = 'ended', ended_at = NOW()
      WHERE id = $1`,
    [roomId]
  );
}

// ── Status transitions usate dal layer WS ─────────────────────────────

export async function markActiveIfPending(roomId: string): Promise<void> {
  await query(
    `UPDATE video_rooms
        SET status = 'active',
            started_at = COALESCE(started_at, NOW())
      WHERE id = $1 AND status = 'pending'`,
    [roomId]
  );
}

export async function endRoomSystem(roomId: string): Promise<void> {
  // Chiusura "di sistema" (es. ultimo partecipante uscito): non richiede host.
  await query(
    `UPDATE video_rooms
        SET status = 'ended', ended_at = NOW()
      WHERE id = $1 AND status <> 'ended'`,
    [roomId]
  );
}

export async function getDisplayName(userId: string): Promise<{ displayName: string; photoUrl: string | null }> {
  const row = await queryOne<{ display_name: string; photo_url: string | null }>(
    `SELECT COALESCE(name, username) AS display_name, photo_url
       FROM users WHERE id = $1`,
    [userId]
  );
  return {
    displayName: row?.display_name || 'Utente',
    photoUrl: row?.photo_url ?? null,
  };
}
