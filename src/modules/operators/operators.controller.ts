import { FastifyRequest, FastifyReply } from 'fastify';
import * as opService from './operators.service';
import { createOperatorSchema, updateOperatorSchema, listOperatorsQuerySchema } from './operators.schema';
import { ValidationError } from '../../core/errors';
import { AuthRequest } from '../../shared/types';
import { paginate } from '../../shared/pagination';
import { queryOne } from '../../shared/db';

export async function createOperator(request: FastifyRequest, reply: FastifyReply) {
  const parsed = createOperatorSchema.safeParse(request.body);
  if (!parsed.success) throw new ValidationError('Validation failed', parsed.error.flatten());

  const op = await opService.createOperator(parsed.data);
  return reply.status(201).send({ success: true, data: op });
}

export async function getOperator(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const op = await opService.getOperatorById(id);
  return reply.send({ success: true, data: op });
}

// Minimal list accessible to all staff (operator+) for calendar collaboration dropdown
export async function listColleagues(request: FastifyRequest, reply: FastifyReply) {
  const colleagues = await opService.listColleagues();
  return reply.send({ success: true, data: colleagues });
}

export async function listOperators(request: FastifyRequest, reply: FastifyReply) {
  const parsed = listOperatorsQuerySchema.safeParse(request.query);
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());

  const { operators, total } = await opService.listOperators(parsed.data);
  return reply.send({ success: true, ...paginate(operators, total, parsed.data.page, parsed.data.limit) });
}

export async function updateOperator(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const parsed = updateOperatorSchema.safeParse(request.body);
  if (!parsed.success) throw new ValidationError('Validation failed', parsed.error.flatten());

  const op = await opService.updateOperator(id, parsed.data);
  return reply.send({ success: true, data: op });
}

export async function deleteOperator(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id } = request.params as { id: string };
  await opService.deleteOperator(id, req.user.userId);
  return reply.send({ success: true, message: 'Operator deactivated' });
}

export async function promoteToAdmin(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const op = await opService.promoteToAdmin(id);
  return reply.send({ success: true, data: op });
}

export async function demoteFromAdmin(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const op = await opService.demoteFromAdmin(id);
  return reply.send({ success: true, data: op });
}

export async function resetPassword(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const creds = await opService.resetOperatorPassword(id);
  return reply.send({ success: true, data: creds });
}

export async function setPassword(request: FastifyRequest, reply: FastifyReply) {
  const { id } = request.params as { id: string };
  const { password } = request.body as { password: string };
  if (!password || password.length < 8) throw new ValidationError('La password deve avere almeno 8 caratteri');
  const creds = await opService.setOperatorPassword(id, password);
  return reply.send({ success: true, data: creds });
}

export async function uploadPhoto(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id } = request.params as { id: string };
  const { photo } = request.body as { photo: string | null };

  // Basic validation: must be a data URL or null
  if (photo !== null && photo !== undefined && !photo.startsWith('data:image/')) {
    throw new ValidationError('Photo must be a base64 image data URL');
  }

  // Operators can only update their own photo; admins/owners can update any
  const isAdminOrOwner = req.user.role === 'admin' || req.user.role === 'owner';
  if (!isAdminOrOwner) {
    const existing = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM operators WHERE id = $1`, [id]
    );
    if (!existing || existing.user_id !== req.user.userId) {
      return reply.status(403).send({ success: false, message: 'Forbidden' });
    }
  }

  const op = await opService.updateOperatorPhoto(id, photo ?? null);
  return reply.send({ success: true, data: op });
}
