import jwt from 'jsonwebtoken';
import { env } from '../../config/env';

export interface TokenPayload {
  userId: string;
  role: 'client' | 'operator' | 'admin' | 'owner';
}

export function signAccessToken(payload: TokenPayload): string {
  return jwt.sign(payload as object, env().JWT_SECRET, {
    expiresIn: env().JWT_ACCESS_EXPIRY as any,
  });
}

export function signRefreshToken(payload: TokenPayload): string {
  return jwt.sign(payload as object, env().JWT_REFRESH_SECRET, {
    expiresIn: env().JWT_REFRESH_EXPIRY as any,
  });
}

export function verifyAccessToken(token: string): TokenPayload {
  return jwt.verify(token, env().JWT_SECRET) as TokenPayload;
}

export function verifyRefreshToken(token: string): TokenPayload {
  return jwt.verify(token, env().JWT_REFRESH_SECRET) as TokenPayload;
}
