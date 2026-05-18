import { FastifyInstance } from 'fastify';
import { authenticate } from '../../core/auth/middleware';
import * as ctrl from './auth.controller';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Public routes
  app.post('/api/auth/register', ctrl.registerHandler);
  app.post('/api/auth/login', ctrl.loginHandler);
  app.post('/api/auth/refresh', ctrl.refreshHandler);

  // Protected routes
  app.post('/api/auth/logout', { preHandler: [authenticate] }, ctrl.logoutHandler);
  app.get('/api/auth/me', { preHandler: [authenticate] }, ctrl.getMeHandler);
  app.put('/api/auth/change-password', { preHandler: [authenticate] }, ctrl.changePasswordHandler);
  app.put('/api/auth/fcm-token', { preHandler: [authenticate] }, ctrl.updateFcmTokenHandler);
  app.get('/api/auth/preferences', { preHandler: [authenticate] }, ctrl.getDashboardPreferencesHandler);
  app.put('/api/auth/preferences', { preHandler: [authenticate] }, ctrl.updateDashboardPreferencesHandler);
}
