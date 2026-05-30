import { FastifyRequest, FastifyReply } from 'fastify';
import { createReadStream } from 'fs';
import * as authService from './auth.service';
import { loginSchema, registerSchema, refreshSchema, changePasswordSchema, updateProfileSchema, dashboardPreferencesSchema, updateTimezoneSchema } from './auth.schema';
import { BadRequestError, NotFoundError, ValidationError } from '../../core/errors';
import { AuthRequest } from '../../shared/types';

export async function loginHandler(request: FastifyRequest, reply: FastifyReply) {
  const parsed = loginSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }

  const result = await authService.login(parsed.data.email, parsed.data.password);
  return reply.status(200).send({ success: true, data: result });
}

export async function registerHandler(request: FastifyRequest, reply: FastifyReply) {
  const parsed = registerSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }

  const result = await authService.register(
    parsed.data.email,
    parsed.data.password,
    parsed.data.name,
    parsed.data.phone
  );
  return reply.status(201).send({ success: true, data: result });
}

export async function refreshHandler(request: FastifyRequest, reply: FastifyReply) {
  const parsed = refreshSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }

  const tokens = await authService.refreshTokens(parsed.data.refreshToken);
  return reply.status(200).send({ success: true, data: tokens });
}

export async function logoutHandler(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  await authService.logout(req.user.userId);
  return reply.status(200).send({ success: true, message: 'Logged out' });
}

export async function getMeHandler(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const me = await authService.getMe(req.user.userId);
  return reply.status(200).send({ success: true, data: me });
}

export async function updateMeHandler(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const parsed = updateProfileSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }

  const me = await authService.updateProfile(req.user.userId, parsed.data);
  return reply.status(200).send({ success: true, data: me });
}

export async function changePasswordHandler(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const parsed = changePasswordSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }

  await authService.changePassword(
    req.user.userId,
    parsed.data.currentPassword,
    parsed.data.newPassword
  );
  return reply.status(200).send({ success: true, message: 'Password changed' });
}

export async function updateFcmTokenHandler(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { fcmToken } = request.body as { fcmToken: string };
  if (!fcmToken) {
    throw new ValidationError('fcmToken is required');
  }

  await authService.updateFcmToken(req.user.userId, fcmToken);
  return reply.status(200).send({ success: true, message: 'FCM token updated' });
}

export async function updateTimezoneHandler(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const parsed = updateTimezoneSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }

  const me = await authService.updateTimezone(req.user.userId, parsed.data.timezone);
  return reply.status(200).send({ success: true, data: me });
}

export async function getDashboardPreferencesHandler(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { userId } = request.query as { userId?: string };
  // Admin can read any user's preferences
  const targetUserId = (userId && (req.user.role === 'admin' || req.user.role === 'owner')) ? userId : req.user.userId;
  const prefs = await authService.getDashboardPreferences(targetUserId);
  return reply.send({ success: true, data: prefs });
}

export async function updateDashboardPreferencesHandler(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { userId } = request.query as { userId?: string };
  // Admin can update any user's preferences
  const targetUserId = (userId && (req.user.role === 'admin' || req.user.role === 'owner')) ? userId : req.user.userId;
  const parsed = dashboardPreferencesSchema.safeParse(request.body);
  if (!parsed.success) throw new ValidationError('Validation failed', parsed.error.flatten());

  const prefs = await authService.updateDashboardPreferences(targetUserId, parsed.data);
  return reply.send({ success: true, data: prefs });
}

// ── PHOTO PROFILO ──

export async function uploadMePhotoHandler(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;

  if (!request.isMultipart()) {
    throw new BadRequestError('Request must be multipart/form-data');
  }

  // L'endpoint accetta un solo file con field name "photo".
  const file = await (request as any).file();
  if (!file) {
    throw new BadRequestError('Missing "photo" file');
  }

  const result = await authService.updateUserPhoto(req.user.userId, file);
  return reply.send({ success: true, data: { photoUrl: result.photoUrl } });
}

export async function deleteMePhotoHandler(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  await authService.deleteUserPhoto(req.user.userId);
  return reply.send({ success: true, data: { deleted: true } });
}

/**
 * Serve la foto profilo dell'utente come stream (no auth: l'avatar è
 * pubblico, va mostrato come immagine nei contatti).
 * 404 se l'utente non ha foto o il file è mancante.
 */
export async function getUserPhotoFileHandler(request: FastifyRequest, reply: FastifyReply) {
  const { userId } = request.params as { userId: string };
  if (!userId) throw new BadRequestError('userId is required');

  const info = await authService.getUserPhotoFile(userId);
  if (!info) {
    throw new NotFoundError('Photo not found');
  }

  return reply
    .type(info.mimeType)
    .send(createReadStream(info.absolutePath));
}
