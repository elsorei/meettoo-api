import { FastifyRequest, FastifyReply } from 'fastify';
import * as feedService from './feed.service';
import { listPublicFeedQuerySchema } from './feed.schema';
import { ValidationError } from '../../core/errors';

export async function listPublicFeed(request: FastifyRequest, reply: FastifyReply) {
  const parsed = listPublicFeedQuerySchema.safeParse(request.query);
  if (!parsed.success) throw new ValidationError('Invalid query', parsed.error.flatten());

  const items = await feedService.listPublicFeed(parsed.data);
  return reply.send({ success: true, data: items });
}
