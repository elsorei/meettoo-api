import { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../core/auth/middleware';
import * as ctrl from './sharing.controller';

export async function sharingRoutes(app: FastifyInstance): Promise<void> {
  // Ogni account reale ('user' consumer e superiori) gestisce i propri permessi.
  const accountOnly = { preHandler: [authenticate, requireRole('user')] };

  // ── Lista permessi: granted (concessi da me) + received (ricevuti) ──
  app.get('/api/sharing/permissions', accountOnly, ctrl.listMyShares);

  // ── Crea/aggiorna un permesso (solo l'utente stesso può concedere il proprio) ──
  app.post('/api/sharing/permissions', accountOnly, ctrl.createOrUpdateShare);

  // ── Revoca un permesso ──
  app.delete('/api/sharing/permissions/:id', accountOnly, ctrl.revokeShare);
}
