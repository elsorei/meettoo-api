import { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import * as svc from './sharing.service';
import { AuthRequest } from '../../shared/types';
import { ValidationError } from '../../core/errors';

const grantSchema = z.object({
  granteeUserId: z.string().uuid(),
  resource: z.enum(['agenda', 'todo']),
  level: z.enum(['ghost', 'white', 'write']),
});

export async function listMyShares(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const [granted, received] = await Promise.all([
    svc.listGrantedByUser(req.user.userId),
    svc.listReceivedByUser(req.user.userId),
  ]);
  return reply.send({ success: true, data: { granted, received } });
}

export async function createOrUpdateShare(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const parsed = grantSchema.safeParse(request.body);
  if (!parsed.success) throw new ValidationError('Invalid body', parsed.error.flatten());

  const result = await svc.grantPermission(
    req.user.userId,
    parsed.data.granteeUserId,
    parsed.data.resource,
    parsed.data.level,
  );
  return reply.send({ success: true, data: result });
}

export async function revokeShare(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { id } = request.params as { id: string };
  await svc.revokePermission(id, req.user.userId);
  return reply.send({ success: true, message: 'Permesso revocato' });
}
