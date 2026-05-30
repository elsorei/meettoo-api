import type { Namespace, Socket } from 'socket.io';
import type { Server as SocketIOServer } from 'socket.io';
import { verifyAccessToken, TokenPayload } from '../../core/auth/jwt';
import * as videoService from './video.service';
import {
  wsJoinSchema,
  wsLeaveSchema,
  wsSignalingSchema,
} from './video.schema';

// Namespace dedicato: lascia il default '/' dormiente (CLAUDE.md / audit C2).
// L'autenticazione qui è isolata al namespace video.
const NS = '/video';

interface AuthedSocket extends Socket {
  data: Socket['data'] & {
    user?: TokenPayload;
  };
}

function roomKey(roomId: string): string {
  return `vc:${roomId}`;
}

async function findSocketByUser(
  nsp: Namespace,
  roomId: string,
  userId: string
): Promise<AuthedSocket | null> {
  const sockets = await nsp.in(roomKey(roomId)).fetchSockets();
  for (const s of sockets) {
    const data = s.data as { user?: TokenPayload };
    if (data.user?.userId === userId) {
      // s is RemoteSocket; cast through unknown to AuthedSocket because
      // server.io.to().emit() su un id specifico è equivalente.
      return s as unknown as AuthedSocket;
    }
  }
  return null;
}

export function initVideoSocket(io: SocketIOServer): void {
  const nsp: Namespace = io.of(NS);

  // ── Auth middleware: richiede JWT come `auth.token` nell'handshake ──
  nsp.use((socket, next) => {
    const handshakeAuth = socket.handshake.auth as { token?: string } | undefined;
    const token =
      handshakeAuth?.token ||
      (socket.handshake.headers.authorization?.startsWith('Bearer ')
        ? socket.handshake.headers.authorization.slice(7)
        : undefined);

    if (!token) {
      return next(new Error('Token mancante'));
    }
    try {
      const payload = verifyAccessToken(token);
      (socket as AuthedSocket).data.user = payload;
      next();
    } catch {
      next(new Error('Token non valido'));
    }
  });

  nsp.on('connection', (socket: Socket) => {
    const auth = socket as AuthedSocket;
    const user = auth.data.user;
    if (!user) {
      socket.disconnect(true);
      return;
    }
    const userId = user.userId;

    // ── Join ──────────────────────────────────────────────────────────
    socket.on('video:join', async (raw: unknown) => {
      const parsed = wsJoinSchema.safeParse(raw);
      if (!parsed.success) {
        socket.emit('video:error', { message: 'Payload join non valido' });
        return;
      }
      const { roomId } = parsed.data;
      try {
        await videoService.assertCanJoinRoom(roomId, userId);
        await videoService.markActiveIfPending(roomId);

        socket.join(roomKey(roomId));
        const { displayName, photoUrl } = await videoService.getDisplayName(userId);

        socket.to(roomKey(roomId)).emit('video:user-joined', {
          roomId,
          userId,
          displayName,
          photoUrl,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Errore join';
        socket.emit('video:error', { message });
      }
    });

    // ── Leave ─────────────────────────────────────────────────────────
    socket.on('video:leave', async (raw: unknown) => {
      const parsed = wsLeaveSchema.safeParse(raw);
      if (!parsed.success) return;
      const { roomId } = parsed.data;
      socket.leave(roomKey(roomId));
      socket.to(roomKey(roomId)).emit('video:user-left', { roomId, userId });

      // Auto-close se la stanza è vuota.
      const remaining = await nsp.in(roomKey(roomId)).fetchSockets();
      if (remaining.length === 0) {
        await videoService.endRoomSystem(roomId);
      }
    });

    // ── Signaling: offer / answer / ICE ───────────────────────────────
    const forwardSignaling = async (
      event: 'video:offer' | 'video:answer' | 'video:ice-candidate',
      raw: unknown
    ): Promise<void> => {
      const parsed = wsSignalingSchema.safeParse(raw);
      if (!parsed.success) {
        socket.emit('video:error', { message: `Payload ${event} non valido` });
        return;
      }
      const { roomId, toUserId, sdp, candidate } = parsed.data;
      try {
        // Sicurezza: chi inoltra deve essere autorizzato sulla stanza.
        // Il join già ha controllato, ma controlliamo anche qui in caso
        // qualcuno emetta segnalazione senza prima fare join.
        await videoService.assertCanJoinRoom(roomId, userId);

        const target = await findSocketByUser(nsp, roomId, toUserId);
        if (!target) {
          socket.emit('video:error', { message: 'Destinatario non in stanza' });
          return;
        }
        const payload: Record<string, unknown> = { fromUserId: userId, roomId };
        if (event === 'video:ice-candidate') {
          payload.candidate = candidate;
        } else {
          payload.sdp = sdp;
        }
        nsp.to(target.id).emit(event, payload);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Errore signaling';
        socket.emit('video:error', { message });
      }
    };

    socket.on('video:offer',         (raw: unknown) => { void forwardSignaling('video:offer',         raw); });
    socket.on('video:answer',        (raw: unknown) => { void forwardSignaling('video:answer',        raw); });
    socket.on('video:ice-candidate', (raw: unknown) => { void forwardSignaling('video:ice-candidate', raw); });

    // ── Disconnetti: notifica e auto-close ────────────────────────────
    socket.on('disconnecting', () => {
      for (const room of socket.rooms) {
        if (!room.startsWith('vc:')) continue;
        const roomId = room.substring(3);
        socket.to(room).emit('video:user-left', { roomId, userId });

        // Conta i socket rimanenti escludendo questo (che sta uscendo).
        nsp
          .in(room)
          .fetchSockets()
          .then(async (sockets) => {
            const remaining = sockets.filter((s) => s.id !== socket.id).length;
            if (remaining === 0) {
              await videoService.endRoomSystem(roomId);
            }
          })
          .catch(() => {});
      }
    });
  });
}
