import { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../core/auth/middleware';
import * as ctrl from './agenda.controller';

export async function agendaRoutes(app: FastifyInstance): Promise<void> {
  // All agenda routes require authentication
  const auth = { preHandler: [authenticate] };
  const staffOnly = { preHandler: [authenticate, requireRole('operator')] };

  // ── Events CRUD ──
  app.get('/api/events', auth, ctrl.listEvents);
  app.post('/api/events', auth, ctrl.createEvent);
  app.get('/api/events/calendar', auth, ctrl.getCalendarEvents);
  app.get('/api/events/availability', auth, ctrl.checkAvailability);
  app.get('/api/events/multi-availability', auth, ctrl.checkMultiAvailability);
  app.get('/api/events/find-common-slot', auth, ctrl.findCommonSlot);
  app.get('/api/events/busy-slots', auth, ctrl.getBusySlots);
  app.get('/api/events/:id', auth, ctrl.getEvent);
  app.put('/api/events/:id', auth, ctrl.updateEvent);
  app.put('/api/events/:id/move', auth, ctrl.moveEvent);
  app.delete('/api/events/:id', auth, ctrl.deleteEvent);
  app.delete('/api/events/:id/occurrence/:date', auth, ctrl.deleteOccurrence);

  // ── Status & Confirmation ──
  app.put('/api/events/:id/status', auth, ctrl.changeStatus);
  app.put('/api/events/:id/confirm', auth, ctrl.confirmParticipation);

  // ── Convert type ──
  app.post('/api/events/:id/convert', auth, ctrl.convertEvent);

  // ── Participants ──
  app.post('/api/events/:id/participants', auth, ctrl.addParticipant);
  app.delete('/api/events/:id/participants/:userId', auth, ctrl.removeParticipant);

  // ── Calendar permissions (operators only) ──
  app.get('/api/calendar/permissions', staffOnly, ctrl.getCalendarPermissions);
  app.post('/api/calendar/permissions', staffOnly, ctrl.grantCalendarPermission);
  app.delete('/api/calendar/permissions/:viewerUserId', staffOnly, ctrl.revokeCalendarPermission);
}
