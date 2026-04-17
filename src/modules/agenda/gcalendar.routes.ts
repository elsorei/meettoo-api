import { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../core/auth/middleware';
import * as ctrl from './gcalendar.controller';

export async function gcalendarRoutes(app: FastifyInstance): Promise<void> {
  const staffAuth = { preHandler: [authenticate, requireRole('operator')] };

  // Status check
  app.get('/api/gcalendar/status', staffAuth, ctrl.getStatus);

  // OAuth2 flow
  app.get('/api/gcalendar/connect', staffAuth, ctrl.connect);
  app.get('/api/gcalendar/callback', ctrl.callback); // Public - Google redirects here
  app.post('/api/gcalendar/disconnect', staffAuth, ctrl.disconnect);

  // Sync operations
  app.post('/api/gcalendar/export/:eventId', staffAuth, ctrl.exportEvent);
  app.post('/api/gcalendar/import', staffAuth, ctrl.importEvents);
  app.post('/api/gcalendar/sync', staffAuth, ctrl.fullSync);
}
