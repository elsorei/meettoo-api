import { z } from 'zod';

// Crea (o riapre) la stanza video per un evento.
export const createRoomBodySchema = z.object({
  eventId: z.string().uuid(),
});
export type CreateRoomBody = z.infer<typeof createRoomBodySchema>;

// Param :roomId
export const roomIdParamsSchema = z.object({
  roomId: z.string().uuid(),
});
export type RoomIdParams = z.infer<typeof roomIdParamsSchema>;

// Param :eventId
export const eventIdParamsSchema = z.object({
  eventId: z.string().uuid(),
});
export type EventIdParams = z.infer<typeof eventIdParamsSchema>;

// ── Eventi WebSocket (validati al volo lato server prima del forward) ──

export const wsJoinSchema = z.object({
  roomId: z.string().uuid(),
});
export type WsJoinPayload = z.infer<typeof wsJoinSchema>;

export const wsLeaveSchema = z.object({
  roomId: z.string().uuid(),
});
export type WsLeavePayload = z.infer<typeof wsLeaveSchema>;

// Payload SDP/ICE: TIPO non controllato (è opaco al server, lo manda
// invariato al destinatario). Però roomId/toUserId sono validati.
export const wsSignalingSchema = z.object({
  roomId: z.string().uuid(),
  toUserId: z.string().uuid(),
  // sdp o candidate vengono passati attraverso senza ispezione (sono
  // strutture WebRTC opache al signaling).
  sdp: z.unknown().optional(),
  candidate: z.unknown().optional(),
});
export type WsSignalingPayload = z.infer<typeof wsSignalingSchema>;

// ── Tipi di risposta REST ──

export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

export interface VideoRoomDTO {
  id: string;
  event_id: string;
  host_user_id: string;
  status: 'pending' | 'active' | 'ended';
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
}

export interface VideoRoomWithIceDTO extends VideoRoomDTO {
  ice_servers: IceServer[];
}
