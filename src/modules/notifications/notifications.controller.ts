import { FastifyRequest, FastifyReply } from 'fastify';
import * as notifService from './notifications.service';
import { listNotificationsQuerySchema } from './notifications.schema';
import { ValidationError } from '../../core/errors';
import { AuthRequest } from '../../shared/types';
import { paginate } from '../../shared/pagination';

export async function listNotifications(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const parsed = listNotificationsQuerySchema.safeParse(request.query);
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());

  const { notifications, total } = await notifService.listNotifications(req.user.userId, parsed.data);
  return reply.send({ success: true, ...paginate(notifications, total, parsed.data.page, parsed.data.limit) });
}

export async function getUnreadCount(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const count = await notifService.getUnreadCount(req.user.userId);
  return reply.send({ success: true, data: { unreadCount: count } });
}

export async function markAsRead(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id } = request.params as { id: string };
  await notifService.markAsRead(id, req.user.userId);
  return reply.send({ success: true, message: 'Notification marked as read' });
}

export async function markAllAsRead(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const result = await notifService.markAllAsRead(req.user.userId);
  return reply.send({ success: true, data: result });
}
