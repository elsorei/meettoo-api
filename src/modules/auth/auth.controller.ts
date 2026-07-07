import { FastifyRequest, FastifyReply } from 'fastify';
import { createReadStream } from 'fs';
import * as authService from './auth.service';
import { loginSchema, registerSchema, refreshSchema, changePasswordSchema, updateProfileSchema, dashboardPreferencesSchema, updateTimezoneSchema, forgotPasswordSchema, resetPasswordSchema } from './auth.schema';
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

// ── VERIFICA EMAIL ──

export async function requestEmailVerificationHandler(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  await authService.requestEmailVerification(req.user.userId);
  return reply.send({ success: true, message: 'Email di verifica inviata' });
}

/**
 * Conferma via link cliccato nell'email (GET) — risponde con una pagina
 * HTML minimale, perché l'utente arriva dal client di posta.
 */
export async function confirmEmailVerificationHandler(request: FastifyRequest, reply: FastifyReply) {
  const { token } = request.query as { token?: string };
  const ok = token ? await authService.confirmEmailVerification(token) : false;

  const title = ok ? 'Email verificata!' : 'Link non valido o scaduto';
  const body = ok
    ? 'Il tuo indirizzo è stato confermato. Puoi tornare all\'app MeetToo.'
    : 'Richiedi un nuovo link di verifica dall\'app MeetToo.';
  return reply
    .status(ok ? 200 : 400)
    .type('text/html; charset=utf-8')
    .send(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title></head><body style="font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#F4F5FB"><div style="text-align:center;padding:32px;max-width:420px"><h1 style="color:#11131A">${title}</h1><p style="color:#5A6072">${body}</p></div></body></html>`);
}

// ── RESET PASSWORD ──

export async function forgotPasswordHandler(request: FastifyRequest, reply: FastifyReply) {
  const parsed = forgotPasswordSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  await authService.requestPasswordReset(parsed.data.email);
  // Sempre la stessa risposta: nessuna enumerazione degli account.
  return reply.send({ success: true, message: 'Se l\'email esiste, riceverai il link di reset' });
}

export async function resetPasswordHandler(request: FastifyRequest, reply: FastifyReply) {
  const parsed = resetPasswordSchema.safeParse(request.body);
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten());
  }
  const ok = await authService.confirmPasswordReset(parsed.data.token, parsed.data.newPassword);
  if (!ok) {
    throw new BadRequestError('Token non valido o scaduto');
  }
  return reply.send({ success: true, message: 'Password aggiornata. Effettua di nuovo il login.' });
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
