import { Server as HttpServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';

let io: SocketIOServer | null = null;

/**
 * Initialize Socket.io server on top of the HTTP server.
 * Called after Fastify starts listening.
 */
export function initSocketIO(httpServer: HttpServer): SocketIOServer {
  io = new SocketIOServer(httpServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingInterval: 25000,
    pingTimeout: 20000,
    transports: ['websocket', 'polling'],
  });

  console.log('[Socket.io] WebSocket server initialized');
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
}
