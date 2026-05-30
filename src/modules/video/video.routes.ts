import { FastifyInstance } from 'fastify';
import { authenticate } from '../../core/auth/middleware';
import * as ctrl from './video.controller';

export async function videoRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: [authenticate] };

  app.post('/api/video/rooms',                  auth, ctrl.createRoom);
  app.get('/api/video/rooms/by-event/:eventId', auth, ctrl.getRoomByEvent);
  app.post('/api/video/rooms/:roomId/end',      auth, ctrl.endRoom);
}
