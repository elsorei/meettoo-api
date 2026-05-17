/**
 * Push notification triggers.
 * Called from services when relevant events happen.
 * Each trigger creates an in-app notification AND sends a push.
 */
import { sendPushToUser, sendPushToUsers } from './push';
import { createNotification, createBulkNotifications } from '../../modules/notifications/notifications.service';
import { queryMany } from '../../shared/db';

/**
 * New event created — notify all participants except the creator.
 */
export async function triggerNewEvent(
  eventId: string,
  eventTitle: string,
  participantUserIds: string[],
  creatorId: string
): Promise<void> {
  const recipients = participantUserIds.filter(id => id !== creatorId);
  if (recipients.length === 0) return;

  // In-app notification
  await createBulkNotifications(recipients, 'new_event', 'Nuovo evento', `Sei stato invitato a: ${eventTitle}`, { eventId });

  // Push
  await sendPushToUsers(recipients, 'Nuovo evento', eventTitle, { type: 'new_event', eventId, url: '/agenda' });
}

/**
 * New blackboard message — notify channel members except sender.
 */
export async function triggerNewMessage(
  channelId: string,
  channelName: string,
  senderName: string,
  senderUserId: string,
  memberUserIds: string[]
): Promise<void> {
  const recipients = memberUserIds.filter(id => id !== senderUserId);
  if (recipients.length === 0) return;

  // Push only (in-app handled by Socket.io real-time)
  await sendPushToUsers(recipients, `${senderName}`, `Nuovo messaggio in ${channelName}`, { type: 'new_message', channelId, url: '/blackboard' });
}

/**
 * New communication sent to clients.
 */
export async function triggerNewCommunication(
  commId: string,
  subject: string,
  recipientUserIds: string[]
): Promise<void> {
  await createBulkNotifications(recipientUserIds, 'new_communication', 'Nuova comunicazione', subject, { communicationId: commId });
  await sendPushToUsers(recipientUserIds, 'Nuova comunicazione', subject, { type: 'new_communication', communicationId: commId, url: '/email' });
}

/**
 * Video conference invite.
 */
export async function triggerVideoInvite(
  roomId: string,
  roomName: string,
  inviterName: string,
  invitedUserId: string
): Promise<void> {
  await createNotification({ userId: invitedUserId, type: 'video_invite', title: 'Invito Videoconferenza', body: `${inviterName} ti invita a: ${roomName}`, data: { roomId } });
  await sendPushToUser(invitedUserId, 'Videoconferenza', `${inviterName} ti invita a ${roomName}`, { type: 'video_invite', roomId, url: '/videoconference' });
}

/**
 * New file uploaded to client repository.
 */
export async function triggerNewRepoFile(
  fileName: string,
  categoryName: string,
  clientUserId: string
): Promise<void> {
  await createNotification({
    userId: clientUserId,
    type: 'new_document',
    title: 'Nuovo documento in archivio',
    body: `${fileName} — ${categoryName}`,
    data: { url: '/repository' },
  });
  await sendPushToUser(clientUserId, 'Nuovo documento in archivio', `${fileName} — ${categoryName}`, {
    type: 'new_document',
    url: '/repository',
  });
}

/**
 * New news published — notify all clients.
 */
export async function triggerNewsPublished(
  newsId: string,
  newsTitle: string
): Promise<void> {
  const clients = await queryMany<{ user_id: string }>(
    `SELECT user_id FROM clients WHERE user_id IS NOT NULL`
  );
  const userIds = clients.map(c => c.user_id);
  if (userIds.length === 0) return;

  await createBulkNotifications(userIds, 'new_news', 'Nuova news', newsTitle, { newsId, url: '/news' });
  await sendPushToUsers(userIds, 'Nuova news', newsTitle, { type: 'new_news', newsId, url: '/news' });
}

/**
 * Event reminder (1 day, 6 hours, 1 hour before).
 */
export async function triggerEventReminder(
  eventId: string,
  eventTitle: string,
  timeLabel: string,
  participantUserIds: string[]
): Promise<void> {
  await sendPushToUsers(participantUserIds, `Promemoria: ${timeLabel}`, eventTitle, { type: 'event_reminder', eventId, url: '/agenda' });
}
