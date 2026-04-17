import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyAccessToken, TokenPayload } from './jwt';
import { UnauthorizedError, ForbiddenError } from '../errors';
import { Role, hasMinimumRole, hasRole } from './roles';

// Extend Fastify request with user
declare module 'fastify' {
  interface FastifyRequest {
    user?: TokenPayload;
  }
}

/**
 * Middleware: requires a valid JWT access token.
 * Attaches decoded payload to request.user
 */
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // Try Authorization header first
  let token: string | undefined;
  const header = request.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    token = header.slice(7);
  }

  // Fallback: accept token as query parameter (for downloads/exports opened in new tab)
  if (!token) {
    token = (request.query as any)?.token;
  }

  if (!token) {
    throw new UnauthorizedError('Missing or invalid Authorization header');
  }

  try {
    request.user = verifyAccessToken(token);
  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      throw new UnauthorizedError('Token expired');
    }
    throw new UnauthorizedError('Invalid token');
  }
}

/**
 * Factory: creates a middleware that checks minimum role level.
 * Usage: { preHandler: [authenticate, authorize('admin')] }
 */
export function authorize(...allowedRoles: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      throw new UnauthorizedError();
    }
    if (!hasRole(request.user.role, allowedRoles)) {
      throw new ForbiddenError('Insufficient permissions');
    }
  };
}

/**
 * Factory: requires at least the given role level (uses hierarchy).
 * Usage: { preHandler: [authenticate, requireRole('operator')] }
 */
export function requireRole(minimumRole: Role) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!request.user) {
      throw new UnauthorizedError();
    }
    if (!hasMinimumRole(request.user.role, minimumRole)) {
      throw new ForbiddenError('Insufficient role level');
    }
  };
}
