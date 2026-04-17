import * as admin from 'firebase-admin';
import { env } from '../../config/env';
import { queryOne, queryMany } from '../../shared/db';

let firebaseApp: admin.app.App | null = null;

/**
 * Initialize Firebase Admin SDK.
 * Call once at server startup.
 */
export function initFirebase(): boolean {
  const e = env();
  if (!e.FIREBASE_PROJECT_ID || !e.FIREBASE_CLIENT_EMAIL || !e.FIREBASE_PRIVATE_KEY) {
    console.log('[FCM] Firebase not configured. Push notifications disabled.');
    return false;
  }

  try {
    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert({
        projectId: e.FIREBASE_PROJECT_ID,
        clientEmail: e.FIREBASE_CLIENT_EMAIL,
        // The private key comes with escaped newlines in env vars
        privateKey: e.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      }),
    });
    console.log('[FCM] Firebase Admin initialized');
    return true;
  } catch (err) {
    console.error('[FCM] Firebase init error:', err);
    return false;
  }
}

/**
 * Send a push notification to a specific user by their userId.
 * Looks up their FCM token from the database.
 */
export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<boolean> {
  if (!firebaseApp) return false;

  // Fetch token + unread count in one query — il count va nel badge dell'icona
  const user = await queryOne<{ fcm_token: string | null; unread: number }>(
    `SELECT fcm_token,
     (SELECT COUNT(*)::int FROM notifications WHERE user_id = $1 AND read = false) as unread
     FROM users WHERE id = $1`,
    [userId]
  );

  if (!user?.fcm_token) return false;

  const badgeCount = String(user.unread ?? 1);

  try {
    await admin.messaging().send({
      token: user.fcm_token,
      notification: { title, body },
      data: { ...(data || {}), badge: badgeCount },
      webpush: {
        notification: {
          title,
          body,
          icon: '/icons/icon-192x192.png',
          badge: '/icons/icon-96x96.png',
          tag: data?.type || 'general',
        },
        fcmOptions: {
          link: data?.url || '/dashboard',
        },
      },
    });
    console.log(`[FCM] Push sent to user ${userId}: "${title}" (badge: ${badgeCount})`);
    return true;
  } catch (err: any) {
    if (err.code === 'messaging/registration-token-not-registered') {
      await queryOne('UPDATE users SET fcm_token = NULL WHERE id = $1', [userId]);
      console.log(`[FCM] Cleaned expired token for user ${userId}`);
    } else {
      console.error(`[FCM] Error sending to ${userId}:`, err.message);
    }
    return false;
  }
}

/**
 * Send push to multiple users — batch-loads FCM tokens in one query.
 */
export async function sendPushToUsers(
  userIds: string[],
  title: string,
  body: string,
  data?: Record<string, string>
): Promise<number> {
  if (userIds.length === 0 || !firebaseApp) return 0;

  // Batch-fetch all tokens in one round-trip
  const rows = await queryMany<{ id: string; fcm_token: string }>(
    `SELECT id, fcm_token FROM users WHERE id = ANY($1) AND fcm_token IS NOT NULL`,
    [userIds]
  );

  let sent = 0;
  for (const row of rows) {
    try {
      await admin.messaging().send({
        token: row.fcm_token,
        notification: { title, body },
        data: data || {},
        webpush: {
          notification: { title, body, icon: '/icons/icon-192x192.png', badge: '/icons/icon-96x96.png', tag: data?.type || 'general' },
          fcmOptions: { link: data?.url || '/dashboard' },
        },
      });
      sent++;
    } catch (err: any) {
      if (err.code === 'messaging/registration-token-not-registered') {
        await queryOne('UPDATE users SET fcm_token = NULL WHERE id = $1', [row.id]);
      } else {
        console.error(`[FCM] Error sending to ${row.id}:`, err.message);
      }
    }
  }
  return sent;
}

/**
 * Send push to all operators (staff).
 */
export async function sendPushToAllStaff(
  title: string,
  body: string,
  data?: Record<string, string>,
  excludeUserId?: string
): Promise<number> {
  const staff = await queryMany<{ id: string }>(
    `SELECT u.id FROM users u WHERE u.role IN ('operator','admin','owner') AND u.fcm_token IS NOT NULL AND u.is_active = true`
  );

  const ids = staff.map(s => s.id).filter(id => id !== excludeUserId);
  return sendPushToUsers(ids, title, body, data);
}
