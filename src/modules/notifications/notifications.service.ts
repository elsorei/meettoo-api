import { queryOne, queryMany, query } from '../../shared/db';
import { CreateNotificationInput } from './notifications.schema';

// ── CREATE (called internally by other modules) ──

export async function createNotification(input: CreateNotificationInput): Promise<any> {
  return queryOne(
    `INSERT INTO notifications (user_id, type, title, body, data)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.userId, input.type, input.title || null, input.body || null, JSON.stringify(input.data || {})]
  );
}

/**
 * Send a notification to multiple users at once.
 */
export async function createBulkNotifications(
  userIds: string[],
  type: string,
  title: string,
  body?: string,
  data?: Record<string, any>
): Promise<number> {
  if (userIds.length === 0) return 0;
  // Single multi-row INSERT instead of N separate queries
  const dataJson = JSON.stringify(data || {});
  const bodyVal  = body || null;
  const placeholders = userIds.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}, $${i * 5 + 3}, $${i * 5 + 4}, $${i * 5 + 5})`).join(', ');
  const params = userIds.flatMap(uid => [uid, type, title, bodyVal, dataJson]);
  await query(
    `INSERT INTO notifications (user_id, type, title, body, data) VALUES ${placeholders}`,
    params
  );
  return userIds.length;
}

// ── READ ──

export async function listNotifications(
  userId: string,
  filters: { read?: string; type?: string; page: number; limit: number }
): Promise<{ notifications: any[]; total: number }> {
  const conditions: string[] = ['n.user_id = $1'];
  const params: any[] = [userId];
  let idx = 2;

  if (filters.read !== undefined) {
    conditions.push(`n.read = $${idx}`);
    params.push(filters.read === 'true');
    idx++;
  }

  if (filters.type) {
    conditions.push(`n.type = $${idx}`);
    params.push(filters.type);
    idx++;
  }

  const where = conditions.join(' AND ');
  const offset = (filters.page - 1) * filters.limit;

  const countResult = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM notifications n WHERE ${where}`, params
  );
  const total = parseInt(countResult?.count || '0', 10);

  const notifications = await queryMany(
    `SELECT n.id, n.type, n.title, n.body, n.data, n.read, n.read_at, n.created_at
     FROM notifications n
     WHERE ${where}
     ORDER BY n.created_at DESC
     LIMIT $${idx} OFFSET $${idx + 1}`,
    [...params, filters.limit, offset]
  );

  return { notifications, total };
}

// ── MARK AS READ ──

export async function markAsRead(notificationId: string, userId: string): Promise<void> {
  await query(
    `UPDATE notifications SET read = true, read_at = NOW()
     WHERE id = $1 AND user_id = $2 AND read = false`,
    [notificationId, userId]
  );
}

export async function markAllAsRead(userId: string): Promise<{ marked: number }> {
  const result = await query(
    `UPDATE notifications SET read = true, read_at = NOW()
     WHERE user_id = $1 AND read = false`,
    [userId]
  );
  return { marked: result.rowCount || 0 };
}

// ── UNREAD COUNT ──

export async function getUnreadCount(userId: string): Promise<number> {
  const result = await queryOne<{ count: string }>(
    `SELECT COUNT(*) as count FROM notifications WHERE user_id = $1 AND read = false`,
    [userId]
  );
  return parseInt(result?.count || '0', 10);
}

// ── DELETE OLD ──

export async function deleteOldNotifications(userId: string, olderThanDays: number = 30): Promise<{ deleted: number }> {
  const result = await query(
    `DELETE FROM notifications WHERE user_id = $1 AND created_at < NOW() - INTERVAL '1 day' * $2`,
    [userId, olderThanDays]
  );
  return { deleted: result.rowCount || 0 };
}

// ── NOTIFICATION HELPERS (used by other modules) ──

export async function notifyNewEvent(eventId: string, eventTitle: string, recipientUserIds: string[], senderId: string): Promise<void> {
  await createBulkNotifications(
    recipientUserIds.filter(id => id !== senderId),
    'new_event',
    'Nuovo evento',
    `Sei stato invitato a: ${eventTitle}`,
    { eventId }
  );
}

export async function notifyEventConfirmed(eventId: string, eventTitle: string, organizerUserId: string, confirmerName: string): Promise<void> {
  await createNotification({
    userId: organizerUserId,
    type: 'event_confirmed',
    title: 'Evento confermato',
    body: `${confirmerName} ha confermato la partecipazione a: ${eventTitle}`,
    data: { eventId },
  });
}

export async function notifyNewMessage(channelId: string, channelName: string, senderName: string, recipientUserIds: string[], senderId: string): Promise<void> {
  await createBulkNotifications(
    recipientUserIds.filter(id => id !== senderId),
    'new_message',
    `Nuovo messaggio da ${senderName}`,
    `in ${channelName}`,
    { channelId }
  );
}

export async function notifyNewCommunication(commId: string, subject: string, recipientUserIds: string[]): Promise<void> {
  await createBulkNotifications(
    recipientUserIds,
    'new_communication',
    'Nuova comunicazione',
    subject,
    { communicationId: commId }
  );
}

export async function notifyNewDocument(docId: string, fileName: string, clientUserId: string): Promise<void> {
  await createNotification({
    userId: clientUserId,
    type: 'new_document',
    title: 'Nuovo documento',
    body: `Un nuovo documento e stato caricato: ${fileName}`,
    data: { documentId: docId },
  });
}
