import { FastifyInstance } from 'fastify';
import { authenticate } from '../../core/auth/middleware';
import * as ctrl from './notifications.controller';

export async function notificationsRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: [authenticate] };

  app.get('/api/notifications', auth, ctrl.listNotifications);
  app.get('/api/notifications/unread-count', auth, ctrl.getUnreadCount);
  app.put('/api/notifications/:id/read', auth, ctrl.markAsRead);
  app.put('/api/notifications/read-all', auth, ctrl.markAllAsRead);
}
