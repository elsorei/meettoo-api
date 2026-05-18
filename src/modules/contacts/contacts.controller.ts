import { FastifyRequest, FastifyReply } from 'fastify';
import * as contactsService from './contacts.service';
import { sendRequestSchema, searchQuerySchema, matchPhonesSchema } from './contacts.schema';
import { ValidationError } from '../../core/errors';
import { AuthRequest } from '../../shared/types';

export async function listContacts(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const contacts = await contactsService.listContacts(req.user.userId);
  return reply.send({ success: true, data: contacts });
}

export async function listRequests(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const requests = await contactsService.listRequests(req.user.userId);
  return reply.send({ success: true, data: requests });
}

export async function sendRequest(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const parsed = sendRequestSchema.safeParse(request.body);
  if (!parsed.success) throw new ValidationError('Validation failed', parsed.error.flatten());

  const result = await contactsService.sendRequest(req.user.userId, parsed.data.userId);
  return reply.status(201).send({ success: true, data: result });
}

export async function acceptRequest(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id } = request.params as { id: string };
  await contactsService.acceptRequest(req.user.userId, id);
  return reply.send({ success: true, message: 'Richiesta accettata' });
}

export async function declineRequest(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id } = request.params as { id: string };
  await contactsService.declineRequest(req.user.userId, id);
  return reply.send({ success: true, message: 'Richiesta rifiutata' });
}

export async function removeContact(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { userId } = request.params as { userId: string };
  await contactsService.removeContact(req.user.userId, userId);
  return reply.send({ success: true, message: 'Contatto rimosso' });
}

export async function searchUsers(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const parsed = searchQuerySchema.safeParse(request.query);
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());

  const users = await contactsService.searchUsers(req.user.userId, parsed.data.q);
  return reply.send({ success: true, data: users });
}

export async function matchPhones(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const parsed = matchPhonesSchema.safeParse(request.body);
  if (!parsed.success) throw new ValidationError('Validation failed', parsed.error.flatten());

  const users = await contactsService.matchPhones(req.user.userId, parsed.data.phones);
  return reply.send({ success: true, data: users });
}
