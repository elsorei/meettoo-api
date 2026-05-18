import { FastifyInstance } from 'fastify';
import { authenticate } from '../../core/auth/middleware';
import * as ctrl from './contacts.controller';

export async function contactsRoutes(app: FastifyInstance): Promise<void> {
  const auth = { preHandler: [authenticate] };

  app.get('/api/contacts', auth, ctrl.listContacts);
  app.get('/api/contacts/requests', auth, ctrl.listRequests);
  app.get('/api/contacts/search', auth, ctrl.searchUsers);
  app.post('/api/contacts/match', auth, ctrl.matchPhones);
  app.post('/api/contacts/requests', auth, ctrl.sendRequest);
  app.post('/api/contacts/requests/:id/accept', auth, ctrl.acceptRequest);
  app.delete('/api/contacts/requests/:id', auth, ctrl.declineRequest);
  app.delete('/api/contacts/:userId', auth, ctrl.removeContact);
}
