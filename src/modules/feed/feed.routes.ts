import { FastifyInstance } from 'fastify';
import { authenticate } from '../../core/auth/middleware';
import * as ctrl from './feed.controller';

export async function feedRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: [authenticate] };

  // Feed pubblico: sola lettura. Auth richiesta per limitare ai soli
  // utenti Meettoo. Nessuna mutation (commenti/RSVP) qui.
  app.get('/api/feed/public', auth, ctrl.listPublicFeed);
}
