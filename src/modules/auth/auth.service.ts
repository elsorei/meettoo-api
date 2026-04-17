import { queryOne, query } from '../../shared/db';
import { verifyPassword, hashPassword } from '../../core/auth/password';
import { signAccessToken, signRefreshToken, verifyRefreshToken, TokenPayload } from '../../core/auth/jwt';
import { getRedis } from '../../config/redis';
import { UnauthorizedError, NotFoundError, BadRequestError } from '../../core/errors';
import { Role } from '../../core/auth/roles';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  password_version: number;
  role: Role;
  is_active: boolean;
}

interface LoginResult {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    username: string;
    role: Role;
    profile: any;
  };
}

export async function login(username: string, password: string): Promise<LoginResult> {
  const user = await queryOne<UserRow>(
    'SELECT id, username, password_hash, password_version, role, is_active FROM users WHERE username = $1',
    [username.toLowerCase().trim()]
  );

  if (!user) {
    throw new UnauthorizedError('Invalid credentials');
  }

  if (!user.is_active) {
    throw new UnauthorizedError('Account is disabled');
  }

  const { valid, needsUpgrade } = await verifyPassword(
    password,
    user.password_hash,
    user.password_version
  );

  if (!valid) {
    throw new UnauthorizedError('Invalid credentials');
  }

  // Upgrade legacy SHA256 to bcrypt transparently
  if (needsUpgrade) {
    const newHash = await hashPassword(password);
    await query(
      'UPDATE users SET password_hash = $1, password_version = 2, updated_at = NOW() WHERE id = $2',
      [newHash, user.id]
    );
  }

  // Update last_login
  await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

  const payload: TokenPayload = { userId: user.id, role: user.role };
  const accessToken = signAccessToken(payload);
  const refreshToken = signRefreshToken(payload);

  // Store refresh token in Redis (for invalidation on logout)
  const redis = await getRedis();
  await redis.set(`refresh:${user.id}`, refreshToken, { EX: 30 * 24 * 3600 });

  // Fetch profile data based on role
  const profile = await getProfile(user.id, user.role);

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      username: user.username,
      role: user.role,
      profile,
    },
  };
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

export async function getProfile(userId: string, role: Role): Promise<any> {
  if (role === 'client') {
    return queryOne(
      `SELECT c.id, c.legacy_code, c.business_name, c.fiscal_code, c.vat_number,
              c.primary_email, c.modules, c.metadata
       FROM clients c WHERE c.user_id = $1`,
      [userId]
    );
  }
  // operator, admin, owner
  return queryOne(
    `SELECT o.id, o.email, o.first_name, o.last_name, o.department,
            o.is_admin, o.is_owner, o.photo
     FROM operators o WHERE o.user_id = $1`,
    [userId]
  );
}

export async function getMe(userId: string): Promise<any> {
  const user = await queryOne<{ id: string; username: string; role: Role }>(
    'SELECT id, username, role FROM users WHERE id = $1',
    [userId]
  );
  if (!user) throw new NotFoundError('User not found');

  const profile = await getProfile(userId, user.role);
  return { ...user, profile };
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
