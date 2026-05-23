import { FastifyRequest, FastifyReply } from 'fastify';
import { createReadStream } from 'fs';
import * as agendaService from './agenda.service';
import * as availabilityService from './availability.service';
import * as commonAvail from './common-availability.service';
import {
  createEventSchema, updateEventSchema, changeStatusSchema,
  confirmParticipationSchema, convertEventSchema, moveEventSchema,
  listEventsQuerySchema, availabilityQuerySchema, addParticipantSchema,
  attachmentEventParamSchema, attachmentParamsSchema,
} from './agenda.schema';
import { BadRequestError, ValidationError } from '../../core/errors';
import { AuthRequest } from '../../shared/types';
import { paginate } from '../../shared/pagination';

// ── CRUD ──

export async function createEvent(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const parsed = createEventSchema.safeParse(request.body);
  if (!parsed.success) throw new ValidationError('Validation failed', parsed.error.flatten());

  const event = await agendaService.createEvent(req.user.userId, parsed.data);
  return reply.status(201).send({ success: true, data: event });
}

export async function getEvent(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id } = request.params as { id: string };

  const event = await agendaService.getEventById(id, req.user.userId);
  return reply.send({ success: true, data: event });
}

export async function listEvents(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const parsed = listEventsQuerySchema.safeParse(request.query);
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());

  const { events, total } = await agendaService.listEvents(
    req.user.userId, req.user.role, parsed.data
  );

  return reply.send({
    success: true,
    ...paginate(events, total, parsed.data.page, parsed.data.limit),
  });
}

export async function getCalendarEvents(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { from, to, operatorId } = request.query as { from: string; to: string; operatorId?: string };

  if (!from || !to) throw new ValidationError('from and to query params are required');

  const events = await agendaService.getCalendarEvents(
    req.user.userId, req.user.role, from, to, operatorId
  );
  return reply.send({ success: true, data: events });
}

export async function updateEvent(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id } = request.params as { id: string };
  const parsed = updateEventSchema.safeParse(request.body);
  if (!parsed.success) throw new ValidationError('Validation failed', parsed.error.flatten());

  const event = await agendaService.updateEvent(id, req.user.userId, req.user.role, parsed.data);
  return reply.send({ success: true, data: event });
}

export async function moveEvent(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id } = request.params as { id: string };
  const parsed = moveEventSchema.safeParse(request.body);
  if (!parsed.success) throw new ValidationError('Validation failed', parsed.error.flatten());

  const event = await agendaService.moveEvent(
    id, req.user.userId, req.user.role,
    parsed.data.eventDate, parsed.data.startTime, parsed.data.endTime
  );
  return reply.send({ success: true, data: event });
}

export async function deleteEvent(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id } = request.params as { id: string };

  await agendaService.deleteEvent(id, req.user.userId, req.user.role);
  return reply.send({ success: true, message: 'Event deleted' });
}

// ── STATUS & CONFIRMATION ──

export async function changeStatus(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id } = request.params as { id: string };
  const parsed = changeStatusSchema.safeParse(request.body);
  if (!parsed.success) throw new ValidationError('Validation failed', parsed.error.flatten());

  const event = await agendaService.changeEventStatus(
    id, req.user.userId, req.user.role, parsed.data.status
  );
  return reply.send({ success: true, data: event });
}

export async function confirmParticipation(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id } = request.params as { id: string };
  const parsed = confirmParticipationSchema.safeParse(request.body);
  if (!parsed.success) throw new ValidationError('Validation failed', parsed.error.flatten());

  const event = await agendaService.confirmParticipation(
    id, req.user.userId, parsed.data.confirmation
  );
  return reply.send({ success: true, data: event });
}

// ── CONVERT ──

export async function convertEvent(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id } = request.params as { id: string };
  const parsed = convertEventSchema.safeParse(request.body);
  if (!parsed.success) throw new ValidationError('Validation failed', parsed.error.flatten());

  const event = await agendaService.convertEvent(
    id, req.user.userId, req.user.role,
    parsed.data.newType, parsed.data.startTime, parsed.data.endTime
  );
  return reply.send({ success: true, data: event });
}

// ── AVAILABILITY ──

export async function checkAvailability(request: FastifyRequest, reply: FastifyReply) {
  const parsed = availabilityQuerySchema.safeParse(request.query);
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());

  const result = await availabilityService.checkAvailability(
    parsed.data.userId, parsed.data.date,
    parsed.data.startTime, parsed.data.endTime,
    parsed.data.excludeEventId
  );
  return reply.send({ success: true, data: result });
}

export async function getBusySlots(request: FastifyRequest, reply: FastifyReply) {
  const { userId, from, to } = request.query as { userId: string; from: string; to: string };
  if (!userId || !from || !to) throw new ValidationError('userId, from and to are required');

  const slots = await availabilityService.getBusySlots(userId, from, to);
  return reply.send({ success: true, data: slots });
}

// ── PARTICIPANTS ──

export async function addParticipant(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id } = request.params as { id: string };
  const parsed = addParticipantSchema.safeParse(request.body);
  if (!parsed.success) throw new ValidationError('Validation failed', parsed.error.flatten());

  const event = await agendaService.addParticipant(
    id, req.user.userId, req.user.role,
    parsed.data.userId, parsed.data.role
  );
  return reply.send({ success: true, data: event });
}

export async function removeParticipant(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id, userId } = request.params as { id: string; userId: string };

  const event = await agendaService.removeParticipant(
    id, req.user.userId, req.user.role, userId
  );
  return reply.send({ success: true, data: event });
}

// ── CALENDAR PERMISSIONS ──

export async function getCalendarPermissions(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const perms = await agendaService.getCalendarPermissions(req.user.userId);
  return reply.send({ success: true, data: perms });
}

export async function grantCalendarPermission(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { viewerUserId, canEdit } = request.body as { viewerUserId: string; canEdit?: boolean };

  await agendaService.grantCalendarPermission(req.user.userId, viewerUserId, canEdit || false);
  return reply.send({ success: true, message: 'Permission granted' });
}

export async function revokeCalendarPermission(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { viewerUserId } = request.params as { viewerUserId: string };

  await agendaService.revokeCalendarPermission(req.user.userId, viewerUserId);
  return reply.send({ success: true, message: 'Permission revoked' });
}

// ── Recurring events ──

export async function deleteOccurrence(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id, date } = request.params as { id: string; date: string };

  await agendaService.deleteOccurrence(id, date, req.user.userId, req.user.role);
  return reply.code(204).send();
}

// ── Multi-operator availability ──

export async function checkMultiAvailability(request: FastifyRequest, reply: FastifyReply) {
  const { userIds, date, startTime, endTime } = request.query as { userIds: string; date: string; startTime: string; endTime: string };
  if (!userIds || !date || !startTime || !endTime) throw new ValidationError('userIds, date, startTime, endTime required');

  const ids = userIds.split(',');
  const result = await commonAvail.checkMultiAvailability(ids, date, startTime, endTime);
  return reply.send({ success: true, data: result });
}

export async function findCommonSlot(request: FastifyRequest, reply: FastifyReply) {
  const { userIds, fromDate, duration } = request.query as { userIds: string; fromDate: string; duration: string };
  if (!userIds || !fromDate) throw new ValidationError('userIds and fromDate required');

  const ids = userIds.split(',');
  const durationMin = parseInt(duration) || 60;
  const slot = await commonAvail.findCommonSlot(ids, fromDate, durationMin);
  return reply.send({ success: true, data: slot });
}

// ── ATTACHMENTS ──

export async function uploadAttachments(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const parsed = attachmentEventParamSchema.safeParse(request.params);
  if (!parsed.success) throw new ValidationError('Invalid event id', parsed.error.flatten());

  if (!request.isMultipart()) {
    throw new BadRequestError('Request must be multipart/form-data');
  }

  const parts = request.parts();
  const attachments = await agendaService.uploadAttachments(parsed.data.id, req.user.userId, parts);
  return reply.status(201).send({ success: true, data: { attachments } });
}

export async function listAttachments(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const parsed = attachmentEventParamSchema.safeParse(request.params);
  if (!parsed.success) throw new ValidationError('Invalid event id', parsed.error.flatten());

  const attachments = await agendaService.listAttachments(parsed.data.id, req.user.userId);
  return reply.send({ success: true, data: { attachments } });
}

export async function downloadAttachment(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const parsed = attachmentParamsSchema.safeParse(request.params);
  if (!parsed.success) throw new ValidationError('Invalid params', parsed.error.flatten());

  const info = await agendaService.getAttachmentForDownload(
    parsed.data.id, parsed.data.attId, req.user.userId
  );

  // Codifica RFC 5987 per filename con caratteri non-ASCII (es. accenti).
  const asciiFallback = info.fileName.replace(/[^\x20-\x7E]/g, '_');
  const encoded = encodeURIComponent(info.fileName);

  return reply
    .header(
      'Content-Disposition',
      `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
    )
    .type(info.mimeType)
    .send(createReadStream(info.absolutePath));
}

export async function deleteAttachment(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const parsed = attachmentParamsSchema.safeParse(request.params);
  if (!parsed.success) throw new ValidationError('Invalid params', parsed.error.flatten());

  await agendaService.deleteAttachment(parsed.data.id, parsed.data.attId, req.user.userId, req.user.role);
  return reply.send({ success: true, data: { deleted: true } });
}
