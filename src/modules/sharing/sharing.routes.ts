import { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../core/auth/middleware';
import * as ctrl from './sharing.controller';

export async function sharingRoutes(app: FastifyInstance): Promise<void> {
  const staffOnly = { preHandler: [authenticate, requireRole('operator')] };

  // ── Lista permessi: granted (concessi da me) + received (ricevuti) ──
  app.get('/api/sharing/permissions', staffOnly, ctrl.listMyShares);

  // ── Crea/aggiorna un permesso (solo l'utente stesso può concedere il proprio) ──
  app.post('/api/sharing/permissions', staffOnly, ctrl.createOrUpdateShare);

  // ── Revoca un permesso ──
  app.delete('/api/sharing/permissions/:id', staffOnly, ctrl.revokeShare);
}
