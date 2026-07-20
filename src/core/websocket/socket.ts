import { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { getRedis } from '../../config/redis';
import { isOriginAllowed } from '../../config/cors';

let io: SocketIOServer | null = null;
let pubClient: Awaited<ReturnType<typeof getRedis>> | null = null;
let subClient: Awaited<ReturnType<typeof getRedis>> | null = null;

/**
 * Initialize Socket.io server on top of the HTTP server.
 * Called after Fastify starts listening.
 *
 * Usa il Redis adapter: gli eventi (segnaletica video, realtime) vengono
 * propagati via pub/sub, quindi il server può girare su più istanze dietro
 * un load balancer. Il CORS è lo stesso dell'HTTP (config/cors.ts).
 */
export async function initSocketIO(httpServer: HttpServer): Promise<SocketIOServer> {
  const base = await getRedis();
  pubClient = base.duplicate();
  subClient = base.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);

  io = new SocketIOServer(httpServer, {
    adapter: createAdapter(pubClient, subClient),
    cors: {
      origin: (origin, cb) => cb(null, isOriginAllowed(origin ?? undefined)),
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 20000,
    transports: ['websocket', 'polling'],
  });

  console.log('[Socket.io] WebSocket server initialized (Redis adapter)');
  return io;
}

/**
 * Get the Socket.io server instance.
 */
export function getIO(): SocketIOServer | null {
  return io;
}

/**
 * Gracefully close Socket.io.
 */
export async function closeSocketIO(): Promise<void> {
  if (io) {
    io.close();
    io = null;
  }
  await Promise.allSettled([
    pubClient?.quit() ?? Promise.resolve(),
    subClient?.quit() ?? Promise.resolve(),
  ]);
  pubClient = null;
  subClient = null;
}
