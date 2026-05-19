import { queryOne, queryMany } from '../../shared/db';

/**
 * Notifiche push tramite il servizio di Expo.
 * https://docs.expo.dev/push-notifications/sending-notifications/
 *
 * Il token salvato in users.fcm_token e un Expo push token ("ExponentPushToken[...]").
 */
const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/** Nessuna inizializzazione necessaria: il push passa dal servizio di Expo. */
export function initPush(): boolean {
  console.log('[push] Notifiche push via Expo attive');
  return true;
}

/** Invia un singolo messaggio a un token Expo. Restituisce l'esito. */
async function inviaExpo(
  token: string,
  title: string,
  body: string,
  data: Record<string, string>,
  badge?: number,
): Promise<'ok' | 'invalid' | 'error'> {
  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        to: token,
        title,
        body,
        data,
        sound: 'default',
        ...(badge !== undefined ? { badge } : {}),
      }),
    });
    const json = (await res.json().catch(() => null)) as any;
    const ticket = json?.data;
    if (ticket?.status === 'error') {
      // Token non piu valido: va rimosso dal database.
      if (ticket?.details?.error === 'DeviceNotRegistered') return 'invalid';
      console.error('[push] Errore ticket Expo:', ticket?.message);
      return 'error';
    }
    return 'ok';
  } catch (err) {
    console.error('[push] Errore invio Expo:', err);
    return 'error';
  }
}

/**
 * Invia una notifica push a un utente (cerca il suo token in users.fcm_token).
 */
export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<boolean> {
  // Token + conteggio non letti in una query — il count va nel badge dell'icona.
  const user = await queryOne<{ fcm_token: string | null; unread: number }>(
    `SELECT fcm_token,
     (SELECT COUNT(*)::int FROM notifications WHERE user_id = $1 AND read = false) as unread
     FROM users WHERE id = $1`,
    [userId],
  );
  if (!user?.fcm_token) return false;

  const esito = await inviaExpo(user.fcm_token, title, body, data || {}, user.unread ?? 1);
  if (esito === 'invalid') {
    await queryOne('UPDATE users SET fcm_token = NULL WHERE id = $1', [userId]);
    console.log(`[push] Token non valido rimosso per l'utente ${userId}`);
    return false;
  }
  return esito === 'ok';
}

/**
 * Invia una notifica push a piu utenti — carica i token in una sola query.
 */
export async function sendPushToUsers(
  userIds: string[],
  title: string,
  body: string,
  data?: Record<string, string>,
): Promise<number> {
  if (userIds.length === 0) return 0;

  const rows = await queryMany<{ id: string; fcm_token: string }>(
    `SELECT id, fcm_token FROM users WHERE id = ANY($1) AND fcm_token IS NOT NULL`,
    [userIds],
  );

  let sent = 0;
  for (const row of rows) {
    const esito = await inviaExpo(row.fcm_token, title, body, data || {});
    if (esito === 'ok') sent++;
    else if (esito === 'invalid') {
      await queryOne('UPDATE users SET fcm_token = NULL WHERE id = $1', [row.id]);
    }
  }
  return sent;
}

/**
 * Invia push a tutto lo staff (operatori).
 */
export async function sendPushToAllStaff(
  title: string,
  body: string,
  data?: Record<string, string>,
  excludeUserId?: string,
): Promise<number> {
  const staff = await queryMany<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.role IN ('operator','admin','owner') AND u.fcm_token IS NOT NULL AND u.is_active = true`,
  );
  const ids = staff.map((s) => s.id).filter((id) => id !== excludeUserId);
  return sendPushToUsers(ids, title, body, data);
}
