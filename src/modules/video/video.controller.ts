import { FastifyRequest, FastifyReply } from 'fastify';
import * as videoService from './video.service';
import { AuthRequest } from '../../shared/types';
import { NotFoundError, ValidationError } from '../../core/errors';
import {
  createRoomBodySchema,
  eventIdParamsSchema,
  roomIdParamsSchema,
  VideoRoomWithIceDTO,
} from './video.schema';

export async function createRoom(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = createRoomBodySchema.safeParse(request.body);
  if (!parsed.success) {
    throw new ValidationError('Body non valido', parsed.error.flatten());
  }

  const req = request as AuthRequest;
  const room = await videoService.createOrGetRoom(parsed.data.eventId, req.user.userId);

  const response: VideoRoomWithIceDTO = {
    ...room,
    ice_servers: videoService.getIceServers(),
  };
  reply.status(201).send({ success: true, data: response });
}

export async function getRoomByEvent(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = eventIdParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    throw new ValidationError('Param non valido', parsed.error.flatten());
  }

  const req = request as AuthRequest;
  await videoService.assertCanJoinEvent(parsed.data.eventId, req.user.userId);

  const room = await videoService.findRoomByEvent(parsed.data.eventId);
  if (!room) throw new NotFoundError('Nessuna videochiamata per questo evento');

  const response: VideoRoomWithIceDTO = {
    ...room,
    ice_servers: videoService.getIceServers(),
  };
  reply.send({ success: true, data: response });
}

export async function endRoom(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const parsed = roomIdParamsSchema.safeParse(request.params);
  if (!parsed.success) {
    throw new ValidationError('Param non valido', parsed.error.flatten());
  }

  const req = request as AuthRequest;
  await videoService.endRoom(parsed.data.roomId, req.user.userId);
  reply.send({ success: true, message: 'Videochiamata terminata' });
}
