import { queryOne, query } from '../../shared/db';
import { verifyPassword, hashPassword } from '../../core/auth/password';
import { signAccessToken, signRefreshToken, verifyRefreshToken, TokenPayload } from '../../core/auth/jwt';
import { getRedis } from '../../config/redis';
import { UnauthorizedError, NotFoundError, BadRequestError } from '../../core/errors';
import { Role } from '../../core/auth/roles';
import { normalizePhone } from '../../core/phone';

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
}

interface SessionUser {
  id: string;
  email: string | null;
  name: string | null;
  phone: string | null;
  photoUrl: string | null;
}

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: SessionUser;
}

const SELECT_USER =
  'id, username, email, name, phone, photo_url, password_hash, password_version, role, is_active';

function toSessionUser(row: UserRow): SessionUser {
  return { id: row.id, email: row.email, name: row.name, phone: row.phone, photoUrl: row.photo_url };
}

async function issueTokens(
  userId: string,
  role: Role
): Promise<{ accessToken: string; refreshToken: string }> {
  const payload: TokenPayload = { userId, role };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);
  // Store refresh token in Redis (for invalidation on logout)
  const redis = await getRedis();
  await redis.set(`refresh:${userId}`, refreshToken, { EX: 30 * 24 * 3600 });
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
     VALUES ($1, $1, $2, $3, $4, 2, 'operator', true)
     RETURNING ${SELECT_USER}`,
    [normEmail, name.trim(), normPhone, passwordHash]
  );
  if (!user) {
    throw new BadRequestError('Registrazione non riuscita');
  }

  const tokens = await issueTokens(user.id, user.role);
  return { ...tokens, user: toSessionUser(user) };
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

  // Check if refresh token matches stored one (not revoked)
  const redis = await getRedis();
  const stored = await redis.get(`refresh:${payload.userId}`);
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

  const newPayload: TokenPayload = { userId: payload.userId, role: user.role };
  const accessToken = signAccessToken(newPayload);
  const refreshToken = signRefreshToken(newPayload);

  await redis.set(`refresh:${payload.userId}`, refreshToken, { EX: 30 * 24 * 3600 });

  return { accessToken, refreshToken };
}

export async function logout(userId: string): Promise<void> {
  const redis = await getRedis();
  await redis.del(`refresh:${userId}`);
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
