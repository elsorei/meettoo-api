import { createHash, randomBytes } from 'crypto';
import { queryOne, query } from '../../shared/db';

export type AuthTokenKind = 'verify_email' | 'password_reset';

const TOKEN_TTL_HOURS: Record<AuthTokenKind, number> = {
  verify_email: 24,
  password_reset: 1,
};

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Genera un token monouso per l'utente, invalidando quelli precedenti
 * dello stesso tipo. Ritorna il token IN CHIARO (da mettere nel link email);
 * a DB resta solo l'hash SHA-256.
 */
export async function issueAuthToken(userId: string, kind: AuthTokenKind): Promise<string> {
  const token = randomBytes(32).toString('hex');
  const ttl = TOKEN_TTL_HOURS[kind];

  await query(
    `UPDATE auth_tokens SET used_at = NOW()
     WHERE user_id = $1 AND kind = $2 AND used_at IS NULL`,
    [userId, kind]
  );
  await query(
    `INSERT INTO auth_tokens (user_id, kind, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' hours')::interval)`,
    [userId, kind, hashToken(token), String(ttl)]
  );
  return token;
}

/**
 * Consuma un token: se valido (esiste, non usato, non scaduto) lo marca
 * come usato e ritorna lo userId. Altrimenti null.
 */
export async function consumeAuthToken(token: string, kind: AuthTokenKind): Promise<string | null> {
  const row = await queryOne<{ user_id: string }>(
    `UPDATE auth_tokens SET used_at = NOW()
     WHERE token_hash = $1 AND kind = $2 AND used_at IS NULL AND expires_at > NOW()
     RETURNING user_id`,
    [hashToken(token), kind]
  );
  return row?.user_id ?? null;
}
