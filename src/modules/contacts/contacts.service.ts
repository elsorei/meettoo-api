import { queryOne, queryMany, query } from '../../shared/db';
import { NotFoundError, BadRequestError } from '../../core/errors';
import { normalizePhone } from '../../core/phone';

// Campi pubblici di un utente, come compaiono nella rubrica.
const USER_FIELDS = `u.id, u.name, u.username, u.email, u.phone, u.photo_url`;

interface ContactUser {
  id: string;
  name: string | null;
  username: string;
  email: string | null;
  phone: string | null;
  photo_url: string | null;
}

// Sotto-query che etichetta la relazione tra l'utente corrente ($1) e un
// altro utente: 'accepted' | 'pending_outgoing' | 'pending_incoming' | 'none'.
function relationshipSql(otherIdExpr: string): string {
  return `COALESCE((
    SELECT CASE
             WHEN c.status = 'accepted' THEN 'accepted'
             WHEN c.requester_id = $1 THEN 'pending_outgoing'
             ELSE 'pending_incoming'
           END
    FROM contacts c
    WHERE (c.requester_id = $1 AND c.addressee_id = ${otherIdExpr})
       OR (c.requester_id = ${otherIdExpr} AND c.addressee_id = $1)
    LIMIT 1
  ), 'none')`;
}

// ── Lista dei contatti accettati ──
export async function listContacts(userId: string): Promise<ContactUser[]> {
  return queryMany<ContactUser>(
    `SELECT ${USER_FIELDS}
     FROM contacts c
     JOIN users u
       ON u.id = CASE WHEN c.requester_id = $1 THEN c.addressee_id ELSE c.requester_id END
     WHERE (c.requester_id = $1 OR c.addressee_id = $1)
       AND c.status = 'accepted'
       AND u.is_active = true
     ORDER BY COALESCE(u.name, u.username)`,
    [userId]
  );
}

// ── Richieste di amicizia in sospeso (ricevute e inviate) ──
export async function listRequests(
  userId: string
): Promise<{ incoming: any[]; outgoing: any[] }> {
  const incoming = await queryMany(
    `SELECT c.id AS request_id, c.created_at, ${USER_FIELDS}
     FROM contacts c
     JOIN users u ON u.id = c.requester_id
     WHERE c.addressee_id = $1 AND c.status = 'pending' AND u.is_active = true
     ORDER BY c.created_at DESC`,
    [userId]
  );
  const outgoing = await queryMany(
    `SELECT c.id AS request_id, c.created_at, ${USER_FIELDS}
     FROM contacts c
     JOIN users u ON u.id = c.addressee_id
     WHERE c.requester_id = $1 AND c.status = 'pending' AND u.is_active = true
     ORDER BY c.created_at DESC`,
    [userId]
  );
  return { incoming, outgoing };
}

// ── Invio di una richiesta di contatto ──
export async function sendRequest(
  userId: string,
  targetUserId: string
): Promise<{ status: 'pending' | 'accepted' }> {
  if (userId === targetUserId) {
    throw new BadRequestError('Non puoi aggiungere te stesso');
  }

  const target = await queryOne<{ id: string }>(
    `SELECT id FROM users WHERE id = $1 AND is_active = true`,
    [targetUserId]
  );
  if (!target) throw new NotFoundError('Utente non trovato');

  // Richiesta già inviata da me verso di lui?
  const mine = await queryOne<{ status: string }>(
    `SELECT status FROM contacts WHERE requester_id = $1 AND addressee_id = $2`,
    [userId, targetUserId]
  );
  if (mine) {
    throw new BadRequestError(
      mine.status === 'accepted' ? 'Siete già contatti' : 'Richiesta già inviata'
    );
  }

  // L'altro mi aveva già inviato una richiesta? Allora la accetto.
  const reverse = await queryOne<{ id: string; status: string }>(
    `SELECT id, status FROM contacts WHERE requester_id = $1 AND addressee_id = $2`,
    [targetUserId, userId]
  );
  if (reverse) {
    if (reverse.status === 'accepted') {
      throw new BadRequestError('Siete già contatti');
    }
    await query(
      `UPDATE contacts SET status = 'accepted', responded_at = NOW() WHERE id = $1`,
      [reverse.id]
    );
    await notify(targetUserId, 'contact_accepted', userId, 'Richiesta accettata', 'ora è tra i tuoi contatti');
    return { status: 'accepted' };
  }

  await query(
    `INSERT INTO contacts (requester_id, addressee_id, status)
     VALUES ($1, $2, 'pending')
     ON CONFLICT (requester_id, addressee_id) DO NOTHING`,
    [userId, targetUserId]
  );
  await notify(targetUserId, 'contact_request', userId, 'Nuova richiesta di contatto', 'vuole aggiungerti tra i contatti');
  return { status: 'pending' };
}

// ── Accetta una richiesta ricevuta ──
export async function acceptRequest(userId: string, requestId: string): Promise<void> {
  const reqRow = await queryOne<{ requester_id: string }>(
    `SELECT requester_id FROM contacts
     WHERE id = $1 AND addressee_id = $2 AND status = 'pending'`,
    [requestId, userId]
  );
  if (!reqRow) throw new NotFoundError('Richiesta non trovata');

  await query(
    `UPDATE contacts SET status = 'accepted', responded_at = NOW() WHERE id = $1`,
    [requestId]
  );
  await notify(reqRow.requester_id, 'contact_accepted', userId, 'Richiesta accettata', 'ora è tra i tuoi contatti');
}

// ── Rifiuta una richiesta ricevuta o annulla una inviata ──
export async function declineRequest(userId: string, requestId: string): Promise<void> {
  const res = await query(
    `DELETE FROM contacts
     WHERE id = $1 AND status = 'pending'
       AND (addressee_id = $2 OR requester_id = $2)`,
    [requestId, userId]
  );
  if (!res.rowCount) throw new NotFoundError('Richiesta non trovata');
}

// ── Rimuove un contatto accettato ──
export async function removeContact(userId: string, otherUserId: string): Promise<void> {
  const res = await query(
    `DELETE FROM contacts
     WHERE status = 'accepted'
       AND ((requester_id = $1 AND addressee_id = $2)
         OR (requester_id = $2 AND addressee_id = $1))`,
    [userId, otherUserId]
  );
  if (!res.rowCount) throw new NotFoundError('Contatto non trovato');
}

// ── Ricerca utenti per nome / email / telefono ──
export async function searchUsers(userId: string, q: string): Promise<any[]> {
  return queryMany(
    `SELECT ${USER_FIELDS}, ${relationshipSql('u.id')} AS relationship
     FROM users u
     WHERE u.id <> $1 AND u.is_active = true
       AND (u.name ILIKE $2 OR u.email ILIKE $2 OR u.phone ILIKE $2)
     ORDER BY COALESCE(u.name, u.username)
     LIMIT 20`,
    [userId, `%${q}%`]
  );
}

// ── Confronto con la rubrica del telefono ──
// I numeri della rubrica vengono normalizzati in E.164 (default region IT) e
// confrontati con users.phone, anch'esso salvato in E.164. I numeri non
// interpretabili vengono scartati.
export async function matchPhones(userId: string, phones: string[]): Promise<any[]> {
  const normalized = Array.from(
    new Set(
      phones
        .map((p) => normalizePhone(p))
        .filter((p): p is string => p !== null)
    )
  );
  if (normalized.length === 0) return [];
  return queryMany(
    `SELECT ${USER_FIELDS}, ${relationshipSql('u.id')} AS relationship
     FROM users u
     WHERE u.id <> $1 AND u.is_active = true AND u.phone IS NOT NULL
       AND u.phone = ANY($2::text[])
     ORDER BY COALESCE(u.name, u.username)`,
    [userId, normalized]
  );
}

// ── Notifica + push verso un utente ──
async function notify(
  toUserId: string,
  type: string,
  fromUserId: string,
  title: string,
  action: string
): Promise<void> {
  const from = await queryOne<{ name: string }>(
    `SELECT COALESCE(name, username) AS name FROM users WHERE id = $1`,
    [fromUserId]
  );
  const body = `${from?.name || 'Qualcuno'} ${action}`;
  const { createNotification } = await import('../notifications/notifications.service');
  const { sendPushToUser } = await import('../../core/notifications/push');
  await createNotification({ userId: toUserId, type, title, body, data: { fromUserId } });
  setImmediate(() =>
    sendPushToUser(toUserId, title, body, { type, url: '/contatti' }).catch(() => {})
  );
}
