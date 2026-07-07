import { queryOne, query, transaction } from '../../shared/db';
import { verifyPassword, hashPassword } from '../../core/auth/password';
import { signAccessToken, signRefreshToken, verifyRefreshToken, TokenPayload } from '../../core/auth/jwt';
import { getRedis } from '../../config/redis';
import { UnauthorizedError, NotFoundError, BadRequestError } from '../../core/errors';
import { Role } from '../../core/auth/roles';
import { normalizePhone } from '../../core/phone';
import { saveUploadedFile, deleteUploadedFile, getAbsolutePath } from '../../shared/file-upload';
import { existsSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { sendEmail, escapeHtml } from '../../core/email/mailer';
import { issueAuthToken, consumeAuthToken } from './auth-tokens.service';
import { env } from '../../config/env';
import { linkPendingInvitesToUser } from '../agenda/guests.service';

interface UserRow {
  id: string;
  username: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  photo_url: string | null;
  password_hash: string;
  password_version: number;
  role: Role;
  is_active: boolean;
  timezone: string;
  email_verified: boolean;
}

interface SessionUser {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  photoUrl: string | null;
  timezone: string;
  emailVerified: boolean;
}

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

const SELECT_USER =
  'id, username, email, name, phone, photo_url, password_hash, password_version, role, is_active, timezone, email_verified';

function toSessionUser(row: UserRow): SessionUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    phone: row.phone,
    photoUrl: row.photo_url,
    timezone: row.timezone,
    emailVerified: row.email_verified,
  };
}

const REFRESH_TTL_SECONDS = 30 * 24 * 3600;

/** Chiave Redis del refresh token di una singola sessione (dispositivo). */
const refreshKey = (userId: string, sid: string) => `refresh:${userId}:${sid}`;
/** Set Redis con i sid delle sessioni attive dell'utente. */
const sessionsKey = (userId: string) => `sessions:${userId}`;

/**
 * Emette una coppia di token per una NUOVA sessione (dispositivo).
 * Ogni login crea un sid indipendente: accedere dal tablet non disconnette
 * il telefono. Il refresh token vive in Redis per revoca puntuale o globale.
 */
async function issueTokens(
  userId: string,
  role: Role
): Promise<{ accessToken: string; refreshToken: string }> {
  const sid = randomUUID();
  const payload: TokenPayload = { userId, role, sid };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  const redis = await getRedis();
  await redis.set(refreshKey(userId, sid), refreshToken, { EX: REFRESH_TTL_SECONDS });
  await redis.sAdd(sessionsKey(userId), sid);
  await redis.expire(sessionsKey(userId), REFRESH_TTL_SECONDS);
  return { accessToken, refreshToken };
}

/** Registrazione consumer: crea l'account con email + password e apre la sessione. */
export async function register(
  email: string,
  password: string,
  name: string,
  phone?: string
): Promise<LoginResult> {
  const normEmail = email.trim().toLowerCase();

  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM users WHERE LOWER(email) = $1',
    [normEmail]
  );
  if (existing) {
    throw new BadRequestError('Email già registrata');
  }

  // Telefono opzionale: se fornito, va normalizzato in E.164 o rifiutato.
  let normPhone: string | null = null;
  if (phone !== undefined) {
    normPhone = normalizePhone(phone);
    if (!normPhone) {
      throw new BadRequestError('Numero di telefono non valido');
    }
  }

  const passwordHash = await hashPassword(password);
  const user = await queryOne<UserRow>(
    `INSERT INTO users (username, email, name, phone, password_hash, password_version, role, is_active)
     VALUES ($1, $1, $2, $3, $4, 2, 'user', true)
     RETURNING ${SELECT_USER}`,
    [normEmail, name.trim(), normPhone, passwordHash]
  );
  if (!user) {
    throw new BadRequestError('Registrazione non riuscita');
  }

  // Invio email di verifica best-effort: la registrazione non fallisce
  // se l'SMTP è giù, l'utente può richiederla di nuovo dall'app.
  try {
    await sendVerificationEmail(user.id, normEmail, user.name);
  } catch (err) {
    console.error('[auth] invio email di verifica fallito:', err);
  }

  // Aggancia gli inviti guest ricevuti via email prima della registrazione:
  // il nuovo utente trova subito gli eventi a cui è stato invitato.
  try {
    await linkPendingInvitesToUser(user.id, normEmail);
  } catch (err) {
    console.error('[auth] aggancio inviti pendenti fallito:', err);
  }

  const tokens = await issueTokens(user.id, user.role);
  return { ...tokens, user: toSessionUser(user) };
}

// ── VERIFICA EMAIL ──

async function sendVerificationEmail(userId: string, email: string, name: string | null): Promise<void> {
  const token = await issueAuthToken(userId, 'verify_email');
  const link = `${env().APP_URL}/api/auth/verify-email/confirm?token=${token}`;
  await sendEmail(
    email,
    'Conferma il tuo indirizzo email — MeetToo',
    `Ciao ${name || ''}!\n\nConferma il tuo indirizzo email aprendo questo link:\n${link}\n\nIl link scade tra 24 ore. Se non ti sei registrato su MeetToo, ignora questa email.`,
    `<p>Ciao ${escapeHtml(name || '')}!</p><p>Conferma il tuo indirizzo email cliccando il pulsante:</p><p><a href="${link}" style="background:#5A4AF4;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Conferma email</a></p><p>Il link scade tra 24 ore. Se non ti sei registrato su MeetToo, ignora questa email.</p>`
  );
}

/** Richiede (di nuovo) l'email di verifica per l'utente autenticato. */
export async function requestEmailVerification(userId: string): Promise<void> {
  const user = await queryOne<UserRow>(
    `SELECT ${SELECT_USER} FROM users WHERE id = $1`, [userId]
  );
  if (!user) throw new NotFoundError('Utente non trovato');
  if (!user.email) throw new BadRequestError('Nessuna email associata all\'account');
  if (user.email_verified) throw new BadRequestError('Email già verificata');
  await sendVerificationEmail(user.id, user.email, user.name);
}

/** Conferma la verifica email tramite token. Ritorna false se token non valido. */
export async function confirmEmailVerification(token: string): Promise<boolean> {
  const userId = await consumeAuthToken(token, 'verify_email');
  if (!userId) return false;
  await query(
    `UPDATE users SET email_verified = true, email_verified_at = NOW(), updated_at = NOW() WHERE id = $1`,
    [userId]
  );
  return true;
}

// ── RESET PASSWORD ──

/**
 * Richiede il reset password. Risponde sempre allo stesso modo
 * (nessuna enumerazione degli account): se l'email esiste, invia il link.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await queryOne<UserRow>(
    `SELECT ${SELECT_USER} FROM users WHERE LOWER(email) = $1 AND is_active = true`,
    [email.trim().toLowerCase()]
  );
  if (!user || !user.email) return;

  const token = await issueAuthToken(user.id, 'password_reset');
  const link = `${env().APP_URL}/reset-password?token=${token}`;
  await sendEmail(
    user.email,
    'Reimposta la tua password — MeetToo',
    `Ciao ${user.name || ''}!\n\nPer reimpostare la password apri questo link:\n${link}\n\nIl link scade tra 1 ora. Se non hai richiesto il reset, ignora questa email: la tua password resta invariata.`,
    `<p>Ciao ${escapeHtml(user.name || '')}!</p><p>Per reimpostare la password clicca il pulsante:</p><p><a href="${link}" style="background:#5A4AF4;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none">Reimposta password</a></p><p>Il link scade tra 1 ora. Se non hai richiesto il reset, ignora questa email: la tua password resta invariata.</p>`
  );
}

/**
 * Completa il reset: imposta la nuova password e revoca tutte le sessioni
 * (refresh token) esistenti dell'utente.
 */
export async function confirmPasswordReset(token: string, newPassword: string): Promise<boolean> {
  const userId = await consumeAuthToken(token, 'password_reset');
  if (!userId) return false;

  const newHash = await hashPassword(newPassword);
  await query(
    `UPDATE users SET password_hash = $1, password_version = 2, updated_at = NOW() WHERE id = $2`,
    [newHash, userId]
  );
  await revokeAllRefreshTokens(userId);
  return true;
}

/** Revoca tutti i refresh token dell'utente (logout globale, tutti i device). */
export async function revokeAllRefreshTokens(userId: string): Promise<void> {
  const redis = await getRedis();
  const keys = new Set<string>();

  // Sorgente primaria: il set delle sessioni.
  for (const sid of await redis.sMembers(sessionsKey(userId))) {
    keys.add(refreshKey(userId, sid));
  }
  // Fallback difensivo: SCAN per catturare eventuali refresh:{userId}:*
  // orfani (set scaduto prima del token, sessioni legacy). SCAN è O(N) sul
  // keyspace ma è un'operazione rara (reset/logout-all/cancellazione).
  for await (const key of redis.scanIterator({ MATCH: `refresh:${userId}:*`, COUNT: 100 })) {
    if (Array.isArray(key)) key.forEach((k) => keys.add(k));
    else keys.add(key);
  }
  // Include anche la chiave legacy pre-multi-device.
  keys.add(`refresh:${userId}`);

  await redis.del([...keys]);
  await redis.del(sessionsKey(userId));
}

// ── CANCELLAZIONE ACCOUNT (GDPR) ──

/**
 * Cancella l'account dell'utente autenticato (richiede la password).
 *
 * Soft-delete con anonimizzazione: il record users resta (gli eventi passati
 * riferiscono owner_id senza cascade) ma tutti i dati personali vengono
 * rimossi e le credenziali invalidate. In transazione:
 *   - annulla gli eventi futuri di cui è owner
 *   - rimuove partecipazioni, permessi condivisi, contatti, notifiche, token
 *   - anonimizza il record utente e lo disattiva
 * Infine revoca tutti i refresh token.
 */
export async function deleteAccount(userId: string, password: string): Promise<void> {
  const user = await queryOne<UserRow>(
    `SELECT ${SELECT_USER} FROM users WHERE id = $1 AND is_active = true`,
    [userId]
  );
  if (!user) throw new NotFoundError('Utente non trovato');

  const { valid } = await verifyPassword(password, user.password_hash, user.password_version);
  if (!valid) throw new BadRequestError('Password non corretta');

  await transaction(async (client) => {
    await client.query(
      `UPDATE events SET status = 'cancelled', updated_at = NOW()
       WHERE owner_id = $1 AND event_date >= CURRENT_DATE AND status <> 'cancelled'`,
      [userId]
    );
    await client.query(`DELETE FROM event_participants WHERE user_id = $1`, [userId]);
    await client.query(
      `DELETE FROM share_permissions WHERE grantor_user_id = $1 OR grantee_user_id = $1`,
      [userId]
    );
    await client.query(
      `DELETE FROM contacts WHERE requester_id = $1 OR addressee_id = $1`,
      [userId]
    );
    await client.query(`DELETE FROM notifications WHERE user_id = $1`, [userId]);
    await client.query(`DELETE FROM auth_tokens WHERE user_id = $1`, [userId]);
    await client.query(
      `DELETE FROM event_guests WHERE user_id = $1 OR LOWER(email) = LOWER($2)`,
      [userId, user.email ?? '']
    );
    await client.query(
      `UPDATE users SET
         username = 'deleted_' || id,
         email = NULL,
         name = 'Utente eliminato',
         phone = NULL,
         photo_url = NULL,
         fcm_token = NULL,
         password_hash = '!',
         password_version = 2,
         email_verified = false,
         is_active = false,
         dashboard_preferences = '{}',
         deleted_at = NOW(),
         updated_at = NOW()
       WHERE id = $1`,
      [userId]
    );
  });

  // Fuori dalla transazione: file foto e sessioni.
  if (user.photo_url) {
    deleteUploadedFile(user.photo_url);
  }
  await revokeAllRefreshTokens(userId);
}

/** Accesso consumer tramite email + password. */
export async function login(email: string, password: string): Promise<LoginResult> {
  const user = await queryOne<UserRow>(
    `SELECT ${SELECT_USER} FROM users WHERE LOWER(email) = $1`,
    [email.trim().toLowerCase()]
  );

  if (!user) {
    throw new UnauthorizedError('Credenziali non valide');
  }

  if (!user.is_active) {
    throw new UnauthorizedError('Account disattivato');
  }

  const { valid, needsUpgrade } = await verifyPassword(
    password,
    user.password_hash,
    user.password_version
  );

  if (!valid) {
    throw new UnauthorizedError('Credenziali non valide');
  }

  // Upgrade legacy SHA256 hash to bcrypt transparently
  if (needsUpgrade) {
    const newHash = await hashPassword(password);
    await query(
      'UPDATE users SET password_hash = $1, password_version = 2, updated_at = NOW() WHERE id = $2',
      [newHash, user.id]
    );
  }

  await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

  const tokens = await issueTokens(user.id, user.role);
  return { ...tokens, user: toSessionUser(user) };
}

export async function refreshTokens(token: string): Promise<{ accessToken: string; refreshToken: string }> {
  let payload: TokenPayload;
  try {
    payload = verifyRefreshToken(token);
  } catch {
    throw new UnauthorizedError('Invalid refresh token');
  }

  // Token emessi prima del multi-device (senza sid): non più validi.
  if (!payload.sid) {
    throw new UnauthorizedError('Refresh token revoked');
  }

  // La sessione deve esistere in Redis e il token deve combaciare (rotazione:
  // un refresh token già ruotato non è riutilizzabile).
  const redis = await getRedis();
  const stored = await redis.get(refreshKey(payload.userId, payload.sid));
  if (stored !== token) {
    throw new UnauthorizedError('Refresh token revoked');
  }

  // Verify user still exists and is active
  const user = await queryOne<{ is_active: boolean; role: Role }>(
    'SELECT is_active, role FROM users WHERE id = $1',
    [payload.userId]
  );
  if (!user || !user.is_active) {
    throw new UnauthorizedError('Account not found or disabled');
  }

  // Rotazione mantenendo lo stesso sid (stessa sessione/dispositivo).
  const newPayload: TokenPayload = { userId: payload.userId, role: user.role, sid: payload.sid };
  const accessToken = signAccessToken(newPayload);
  const refreshToken = signRefreshToken(newPayload);

  await redis.set(refreshKey(payload.userId, payload.sid), refreshToken, { EX: REFRESH_TTL_SECONDS });
  // Rinnova l'appartenenza al set delle sessioni e ne estende il TTL: senza
  // questo il set scadrebbe a 30 giorni dal LOGIN mentre il refresh token
  // vive a rotazione infinita, e un logout-all/reset non revocherebbe più
  // questa sessione (sMembers tornerebbe vuoto).
  await redis.sAdd(sessionsKey(payload.userId), payload.sid);
  await redis.expire(sessionsKey(payload.userId), REFRESH_TTL_SECONDS);

  return { accessToken, refreshToken };
}

/**
 * Logout della sessione corrente (solo il dispositivo che lo richiede).
 * Se il token non ha sid (legacy) revoca tutte le sessioni.
 */
export async function logout(userId: string, sid?: string): Promise<void> {
  if (!sid) {
    await revokeAllRefreshTokens(userId);
    return;
  }
  const redis = await getRedis();
  await redis.del(refreshKey(userId, sid));
  await redis.sRem(sessionsKey(userId), sid);
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string
): Promise<void> {
  const user = await queryOne<UserRow>(
    'SELECT id, password_hash, password_version FROM users WHERE id = $1',
    [userId]
  );
  if (!user) throw new NotFoundError('User not found');

  const { valid } = await verifyPassword(currentPassword, user.password_hash, user.password_version);
  if (!valid) throw new BadRequestError('Current password is incorrect');

  const newHash = await hashPassword(newPassword);
  await query(
    'UPDATE users SET password_hash = $1, password_version = 2, updated_at = NOW() WHERE id = $2',
    [newHash, userId]
  );
}

/** Profilo dell'utente autenticato. */
export async function getMe(userId: string): Promise<SessionUser> {
  const user = await queryOne<UserRow>(
    `SELECT ${SELECT_USER} FROM users WHERE id = $1`,
    [userId]
  );
  if (!user) throw new NotFoundError('Utente non trovato');
  return toSessionUser(user);
}

/**
 * Aggiorna nome e/o telefono dell'utente autenticato.
 * Il telefono viene normalizzato in E.164; restituisce il profilo aggiornato
 * nella stessa forma di getMe().
 */
export async function updateProfile(
  userId: string,
  fields: { name?: string; phone?: string }
): Promise<SessionUser> {
  const sets: string[] = [];
  const params: unknown[] = [];

  if (fields.name !== undefined) {
    params.push(fields.name.trim());
    sets.push(`name = $${params.length}`);
  }

  if (fields.phone !== undefined) {
    const normPhone = normalizePhone(fields.phone);
    if (!normPhone) {
      throw new BadRequestError('Numero di telefono non valido');
    }
    params.push(normPhone);
    sets.push(`phone = $${params.length}`);
  }

  // Nessun campo da aggiornare: restituisci il profilo corrente.
  if (sets.length === 0) {
    return getMe(userId);
  }

  params.push(userId);
  const user = await queryOne<UserRow>(
    `UPDATE users SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${params.length}
     RETURNING ${SELECT_USER}`,
    params
  );
  if (!user) throw new NotFoundError('Utente non trovato');
  return toSessionUser(user);
}

export async function updateFcmToken(userId: string, fcmToken: string): Promise<void> {
  await query('UPDATE users SET fcm_token = $1, updated_at = NOW() WHERE id = $2', [fcmToken, userId]);
}

/**
 * Aggiorna la timezone IANA dell'utente autenticato.
 * La validazione di lunghezza è in zod; qui non facciamo check IANA stretto
 * (il client manda solo timezone che `Intl.DateTimeFormat()` riconosce).
 */
export async function updateTimezone(userId: string, timezone: string): Promise<SessionUser> {
  const user = await queryOne<UserRow>(
    `UPDATE users SET timezone = $1, updated_at = NOW()
     WHERE id = $2
     RETURNING ${SELECT_USER}`,
    [timezone, userId]
  );
  if (!user) throw new NotFoundError('Utente non trovato');
  return toSessionUser(user);
}

export async function getDashboardPreferences(userId: string): Promise<any> {
  const row = await queryOne<{ dashboard_preferences: any }>(
    'SELECT dashboard_preferences FROM users WHERE id = $1', [userId]
  );
  return row?.dashboard_preferences || {};
}

export async function updateDashboardPreferences(userId: string, prefs: any): Promise<any> {
  const result = await queryOne<{ dashboard_preferences: any }>(
    'UPDATE users SET dashboard_preferences = $1, updated_at = NOW() WHERE id = $2 RETURNING dashboard_preferences',
    [JSON.stringify(prefs), userId]
  );
  return result?.dashboard_preferences || {};
}

// ── PHOTO PROFILO ──

// MIME types accettati per la foto profilo: stessa whitelist degli allegati
// "immagine" (no PDF qui — è solo un avatar).
const ACCEPTED_PHOTO_MIMES = new Set<string>([
  'image/jpeg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
]);

// Limite locale per la foto profilo: 5MB. Il limite globale di @fastify/multipart
// è più alto (50MB), quindi controlliamo qui esplicitamente.
const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Carica/sostituisce la foto profilo dell'utente.
 * - Valida MIME (jpeg/png/heic/heif/webp) e size (<= 5MB) prima di salvare a DB.
 * - Salva sotto users/<userId>/.
 * - Best-effort: cancella il file precedente dopo l'update del DB.
 * Ritorna il nuovo photo_url (path relativo all'UPLOAD_DIR).
 */
export async function updateUserPhoto(
  userId: string,
  file: any // MultipartFile da @fastify/multipart (request.file())
): Promise<{ photoUrl: string }> {
  if (!file) {
    throw new BadRequestError('No file provided');
  }

  const mime = (file.mimetype || '').toLowerCase();
  if (!ACCEPTED_PHOTO_MIMES.has(mime)) {
    // Drena lo stream prima di sollevare per evitare leak.
    try { file.file.resume(); } catch { /* ignore */ }
    throw new BadRequestError(
      `Unsupported photo type: ${mime || 'unknown'}. Allowed: jpeg, png, heic, heif, webp.`
    );
  }

  const uploaded = await saveUploadedFile(file, `users/${userId}`);

  // Controllo size locale (5MB). saveUploadedFile fa il check contro MAX_FILE_SIZE
  // globale (50MB); qui vogliamo un limite più stretto per gli avatar.
  if (uploaded.size > PHOTO_MAX_BYTES) {
    // Rimuovi il file appena salvato.
    try {
      if (existsSync(uploaded.fullPath)) unlinkSync(uploaded.fullPath);
    } catch { /* ignore */ }
    throw new BadRequestError(
      `Photo too large. Max size: ${PHOTO_MAX_BYTES / 1024 / 1024}MB`
    );
  }

  // Aggiorna users.photo_url e leggi il path precedente per cancellarlo.
  const updated = await queryOne<{ old_photo_url: string | null; new_photo_url: string }>(
    `WITH prev AS (
       SELECT photo_url AS old_photo_url FROM users WHERE id = $2
     )
     UPDATE users
        SET photo_url = $1, updated_at = NOW()
       FROM prev
      WHERE users.id = $2
      RETURNING prev.old_photo_url, users.photo_url AS new_photo_url`,
    [uploaded.filePath, userId]
  );

  if (!updated) {
    // Rollback: cancella il file appena salvato.
    deleteUploadedFile(uploaded.filePath);
    throw new NotFoundError('Utente non trovato');
  }

  // Best-effort: cancella il file precedente (se diverso e presente).
  if (updated.old_photo_url && updated.old_photo_url !== uploaded.filePath) {
    deleteUploadedFile(updated.old_photo_url);
  }

  return { photoUrl: updated.new_photo_url };
}

/**
 * Cancella la foto profilo dell'utente.
 * Imposta photo_url = NULL e rimuove il file dal disco (best-effort).
 */
export async function deleteUserPhoto(userId: string): Promise<void> {
  // Pattern WITH prev: cattura il valore precedente prima dell'UPDATE.
  const updated = await queryOne<{ old_photo_url: string | null }>(
    `WITH prev AS (
       SELECT photo_url AS old_photo_url FROM users WHERE id = $1
     )
     UPDATE users
        SET photo_url = NULL, updated_at = NOW()
       FROM prev
      WHERE users.id = $1
      RETURNING prev.old_photo_url`,
    [userId]
  );

  if (!updated) {
    throw new NotFoundError('Utente non trovato');
  }

  if (updated.old_photo_url) {
    deleteUploadedFile(updated.old_photo_url);
  }
}

/**
 * Restituisce il path assoluto della foto profilo, se presente.
 * Usato dall'endpoint pubblico GET /api/auth/me/photo/file/:userId
 * per servire l'avatar come stream. Ritorna null se non c'è foto o
 * il file è mancante a disco.
 */
export async function getUserPhotoFile(
  userId: string
): Promise<{ absolutePath: string; mimeType: string } | null> {
  const row = await queryOne<{ photo_url: string | null }>(
    'SELECT photo_url FROM users WHERE id = $1 AND is_active = true',
    [userId]
  );
  if (!row || !row.photo_url) return null;

  const absolutePath = getAbsolutePath(row.photo_url);
  if (!existsSync(absolutePath)) return null;

  // MIME by extension — semplice e sufficiente per la whitelist nota.
  const ext = row.photo_url.slice(row.photo_url.lastIndexOf('.') + 1).toLowerCase();
  const mimeByExt: Record<string, string> = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    heic: 'image/heic',
    heif: 'image/heif',
    webp: 'image/webp',
  };
  const mimeType = mimeByExt[ext] || 'application/octet-stream';

  return { absolutePath, mimeType };
}
