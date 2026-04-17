import { createHash } from 'crypto';
import bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = 12;

/**
 * Hash a password with bcrypt (for new accounts and upgrades)
 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * Verify a password against its hash.
 * Supports both legacy SHA256 (version 1) and bcrypt (version 2).
 * Returns { valid, needsUpgrade } so the caller can re-hash if needed.
 */
export async function verifyPassword(
  plain: string,
  hash: string,
  version: number
): Promise<{ valid: boolean; needsUpgrade: boolean }> {
  if (version === 1) {
    // Legacy SHA256 (from old PHP system)
    const sha256 = createHash('sha256').update(plain).digest('hex');
    const valid = sha256 === hash;
    return { valid, needsUpgrade: valid }; // upgrade if valid
  }

  // bcrypt (current)
  const valid = await bcrypt.compare(plain, hash);
  return { valid, needsUpgrade: false };
}
