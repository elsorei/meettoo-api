import { FastifyInstance } from 'fastify';
import { authenticate } from '../../core/auth/middleware';
import * as ctrl from './auth.controller';

export async function authRoutes(app: FastifyInstance): Promise<void> {
  // Limiti stretti per-IP sugli endpoint sensibili a brute force e abuso.
  const strictLimit = (max: number, timeWindow = '1 minute') => ({
    config: { rateLimit: { max, timeWindow } },
  });

  // Public routes
  app.post('/api/auth/register', strictLimit(5, '1 minute'), ctrl.registerHandler);
  app.post('/api/auth/login', strictLimit(10, '1 minute'), ctrl.loginHandler);
  app.post('/api/auth/refresh', strictLimit(30, '1 minute'), ctrl.refreshHandler);

  // Protected routes
  app.post('/api/auth/logout', { preHandler: [authenticate] }, ctrl.logoutHandler);
  app.get('/api/auth/me', { preHandler: [authenticate] }, ctrl.getMeHandler);
  app.put('/api/auth/me', { preHandler: [authenticate] }, ctrl.updateMeHandler);
  app.put('/api/auth/change-password', { preHandler: [authenticate] }, ctrl.changePasswordHandler);
  app.put('/api/auth/fcm-token', { preHandler: [authenticate] }, ctrl.updateFcmTokenHandler);
  app.put('/api/auth/me/timezone', { preHandler: [authenticate] }, ctrl.updateTimezoneHandler);
  app.get('/api/auth/preferences', { preHandler: [authenticate] }, ctrl.getDashboardPreferencesHandler);
  app.put('/api/auth/preferences', { preHandler: [authenticate] }, ctrl.updateDashboardPreferencesHandler);

  // Foto profilo: upload/delete autenticati; serving pubblico (avatar nei contatti).
  app.post('/api/auth/me/photo', { preHandler: [authenticate] }, ctrl.uploadMePhotoHandler);
  app.delete('/api/auth/me/photo', { preHandler: [authenticate] }, ctrl.deleteMePhotoHandler);
  app.get('/api/auth/me/photo/file/:userId', ctrl.getUserPhotoFileHandler);
}
