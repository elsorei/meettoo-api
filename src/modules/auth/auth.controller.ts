import { FastifyRequest, FastifyReply } from 'fastify';
import * as authService from './auth.service';
import { loginSchema, registerSchema, refreshSchema, changePasswordSchema, dashboardPreferencesSchema } from './auth.schema';
import { ValidationError } from '../../core/errors';
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
    parsed.data.name
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
