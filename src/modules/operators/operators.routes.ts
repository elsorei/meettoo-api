import { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../core/auth/middleware';
import * as ctrl from './operators.controller';

export async function operatorsRoutes(app: FastifyInstance): Promise<void> {
  const staffOnly = { preHandler: [authenticate, requireRole('operator')] };
  const adminOnly = { preHandler: [authenticate, requireRole('admin')] };
  const ownerOnly = { preHandler: [authenticate, requireRole('owner')] };

  // Minimal list for all staff (used by calendar collaboratori dropdown)
  app.get('/api/operators/colleagues', staffOnly, ctrl.listColleagues);

  app.get('/api/operators', adminOnly, ctrl.listOperators);
  app.post('/api/operators', adminOnly, ctrl.createOperator);
  app.get('/api/operators/:id', adminOnly, ctrl.getOperator);
  app.put('/api/operators/:id', adminOnly, ctrl.updateOperator);
  app.delete('/api/operators/:id', adminOnly, ctrl.deleteOperator);

  // Admin promotion/demotion (owner only)
  app.put('/api/operators/:id/promote', ownerOnly, ctrl.promoteToAdmin);
  app.put('/api/operators/:id/demote', ownerOnly, ctrl.demoteFromAdmin);

  // Reset password
  app.post('/api/operators/:id/reset-password', adminOnly, ctrl.resetPassword);
  app.post('/api/operators/:id/set-password', adminOnly, ctrl.setPassword);

  // Photo — operator can upload own, admin can upload any
  app.put('/api/operators/:id/photo', staffOnly, ctrl.uploadPhoto);
}
