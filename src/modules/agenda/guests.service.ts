import { queryOne, queryMany, query } from '../../shared/db';
import { NotFoundError, ForbiddenError, BadRequestError } from '../../core/errors';
import { sendEmail } from '../../core/email/mailer';
import { env } from '../../config/env';

export interface GuestRow {
  id: string;
  event_id: string;
  user_id: string | null;
  email: string | null;
  name: string | null;
  status: 'pending' | 'accepted' | 'declined';
  invited_by: string | null;
  invited_by_name: string | null;
  created_at: string;
}

/** Lista invitati di un evento, con il nome di chi li ha invitati. */
export async function listGuests(eventId: string): Promise<GuestRow[]> {
  return queryMany<GuestRow>(
    `SELECT g.id, g.event_id, g.user_id,
            COALESCE(u.email, g.email) as email,
            COALESCE(u.name, g.name) as name,
            g.status, g.invited_by,
            COALESCE(inv.name, inv.username) as invited_by_name,
            g.created_at
     FROM event_guests g
     LEFT JOIN users u ON u.id = g.user_id
     LEFT JOIN users inv ON inv.id = g.invited_by
     WHERE g.event_id = $1
     ORDER BY g.created_at`,
    [eventId]
  );
}

/** L'utente è nella lista invitati dell'evento? */
export async function isGuest(eventId: string, userId: string): Promise<boolean> {
  const row = await queryOne(
    `SELECT 1 FROM event_guests WHERE event_id = $1 AND user_id = $2`,
    [eventId, userId]
  );
  return !!row;
}

/**
 * Può `userId` invitare altre persone a questo evento?
 * Sì se è owner/creator, oppure se allow_guests_to_invite è attivo
 * e lui stesso è un invitato (o partecipante).
 */
export async function canInvite(
  event: { id: string; owner_id: string; allow_guests_to_invite?: boolean; created_by_id?: string | null },
  userId: string
): Promise<boolean> {
  if (event.owner_id === userId || event.created_by_id === userId) return true;
  if (!event.allow_guests_to_invite) return false;
  if (await isGuest(event.id, userId)) return true;
  const participant = await queryOne(
    `SELECT 1 FROM event_participants WHERE event_id = $1 AND user_id = $2`,
    [event.id, userId]
  );
  return !!participant;
}

/**
 * Invita una persona via email. Se esiste un account con quella email la
 * riga viene agganciata subito; altrimenti resta "pending senza account"
 * e si aggancia alla registrazione. Invia l'email d'invito best-effort.
 */
export async function inviteGuest(
  eventId: string,
  requesterId: string,
  email: string
): Promise<GuestRow> {
  const event = await queryOne<{
    id: string; owner_id: string; created_by_id: string | null;
    allow_guests_to_invite: boolean; title: string; event_date: string;
  }>(
    `SELECT id, owner_id, created_by_id, allow_guests_to_invite, title, event_date::text as event_date
     FROM events WHERE id = $1`,
    [eventId]
  );
  if (!event) throw new NotFoundError('Event not found');

  if (!(await canInvite(event, requesterId))) {
    throw new ForbiddenError('Non puoi invitare persone a questo evento');
  }

  const normEmail = email.trim().toLowerCase();
  if (!normEmail || !normEmail.includes('@')) {
    throw new BadRequestError('Email non valida');
  }

  // Aggancia subito l'account se esiste.
  const existingUser = await queryOne<{ id: string; name: string | null }>(
    `SELECT id, name FROM users WHERE LOWER(email) = $1 AND is_active = true`,
    [normEmail]
  );

  const inserted = await queryOne<{ id: string }>(
    `INSERT INTO event_guests (event_id, user_id, email, name, invited_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [eventId, existingUser?.id ?? null, normEmail, existingUser?.name ?? null, requesterId]
  );
  if (!inserted) {
    throw new BadRequestError('Questa persona è già stata invitata');
  }

  // Email d'invito best-effort: l'invito resta valido anche se l'SMTP è giù.
  try {
    const inviter = await queryOne<{ name: string | null; username: string }>(
      `SELECT name, username FROM users WHERE id = $1`,
      [requesterId]
    );
    const inviterName = inviter?.name || inviter?.username || 'Un amico';
    const link = `${env().APP_URL}/e/${eventId}`;
    await sendEmail(
      normEmail,
      `${inviterName} ti ha invitato: ${event.title} — MeetToo`,
      `${inviterName} ti ha invitato a "${event.title}" (${event.event_date}).\n\nApri l'invito: ${link}\n\nSe non hai ancora MeetToo, potrai creare l'account in pochi secondi e rispondere all'invito.`,
      `<p><strong>${inviterName}</strong> ti ha invitato a <strong>${event.title}</strong> (${event.event_date}).</p><p><a href="${link}" style="background:#5A4AF4;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Apri l'invito</a></p><p>Se non hai ancora MeetToo, potrai creare l'account in pochi secondi e rispondere all'invito.</p>`
    );
  } catch (err) {
    console.error('[guests] invio email invito fallito:', err);
  }

  const rows = await queryMany<GuestRow>(
    `SELECT g.id, g.event_id, g.user_id,
            COALESCE(u.email, g.email) as email,
            COALESCE(u.name, g.name) as name,
            g.status, g.invited_by,
            COALESCE(inv.name, inv.username) as invited_by_name,
            g.created_at
     FROM event_guests g
     LEFT JOIN users u ON u.id = g.user_id
     LEFT JOIN users inv ON inv.id = g.invited_by
     WHERE g.id = $1`,
    [inserted.id]
  );
  return rows[0];
}

/** Rimuove un invitato. Solo owner/creator dell'evento (o l'invitato stesso). */
export async function removeGuest(
  eventId: string,
  guestId: string,
  requesterId: string
): Promise<void> {
  const event = await queryOne<{ owner_id: string; created_by_id: string | null }>(
    `SELECT owner_id, created_by_id FROM events WHERE id = $1`,
    [eventId]
  );
  if (!event) throw new NotFoundError('Event not found');

  const guest = await queryOne<{ id: string; user_id: string | null }>(
    `SELECT id, user_id FROM event_guests WHERE id = $1 AND event_id = $2`,
    [guestId, eventId]
  );
  if (!guest) throw new NotFoundError('Guest not found');

  const isEventOwner = event.owner_id === requesterId || event.created_by_id === requesterId;
  const isSelf = guest.user_id === requesterId;
  if (!isEventOwner && !isSelf) {
    throw new ForbiddenError('Solo chi ha creato l\'evento può rimuovere gli invitati');
  }

  await query(`DELETE FROM event_guests WHERE id = $1`, [guestId]);
}

/** RSVP dell'invitato (guest): accetta o rifiuta l'invito. */
export async function respondAsGuest(
  eventId: string,
  userId: string,
  status: 'accepted' | 'declined'
): Promise<void> {
  const updated = await queryOne(
    `UPDATE event_guests SET status = $1 WHERE event_id = $2 AND user_id = $3 RETURNING id`,
    [status, eventId, userId]
  );
  if (!updated) throw new NotFoundError('Non sei tra gli invitati di questo evento');
}

/**
 * Aggancia all'account gli inviti pendenti ricevuti via email prima della
 * registrazione. Chiamata alla creazione dell'account.
 */
export async function linkPendingInvitesToUser(userId: string, email: string): Promise<number> {
  const res = await query(
    `UPDATE event_guests SET user_id = $1
     WHERE user_id IS NULL AND LOWER(email) = $2`,
    [userId, email.trim().toLowerCase()]
  );
  return res.rowCount ?? 0;
}
