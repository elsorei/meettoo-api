import { FastifyInstance } from 'fastify';
import { authenticate, requireRole } from '../../core/auth/middleware';
import * as ctrl from './agenda.controller';

export async function agendaRoutes(app: FastifyInstance): Promise<void> {
  // All agenda routes require authentication
  const auth = { preHandler: [authenticate] };
  // Gestione dei permessi sul proprio calendario: aperta a ogni account
  // reale ('user' consumer e superiori), esclusi i 'client' legacy.
  const accountOnly = { preHandler: [authenticate, requireRole('user')] };

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

  // ── Guests (inviti, anche via email a chi non ha account) ──
  // L'invito spedisce email verso indirizzi arbitrari: limite stretto per IP
  // per prevenire spam/abuso di deliverability dal dominio MeetToo.
  const inviteLimit = {
    preHandler: [authenticate],
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  };
  app.post('/api/events/:id/guests', inviteLimit, ctrl.inviteGuest);
  app.delete('/api/events/:id/guests/:guestId', auth, ctrl.removeGuest);
  app.put('/api/events/:id/guests/respond', auth, ctrl.respondAsGuest);

  // ── Attachments ──
  app.post('/api/events/:id/attachments', auth, ctrl.uploadAttachments);
  app.get('/api/events/:id/attachments', auth, ctrl.listAttachments);
  app.get('/api/events/:id/attachments/:attId/download', auth, ctrl.downloadAttachment);
  app.delete('/api/events/:id/attachments/:attId', auth, ctrl.deleteAttachment);

  // ── Calendar permissions (any real account) ──
  app.get('/api/calendar/permissions', accountOnly, ctrl.getCalendarPermissions);
  app.post('/api/calendar/permissions', accountOnly, ctrl.grantCalendarPermission);
  app.delete('/api/calendar/permissions/:viewerUserId', accountOnly, ctrl.revokeCalendarPermission);
}
