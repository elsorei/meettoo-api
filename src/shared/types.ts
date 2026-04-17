import { FastifyRequest } from 'fastify';
import { TokenPayload } from '../core/auth/jwt';

/** Authenticated request - user is guaranteed to exist */
export interface AuthRequest extends FastifyRequest {
  user: TokenPayload;
}

/** Standard paginated query params */
export interface PaginationQuery {
  page?: number;
  limit?: number;
}

/** Standard paginated response wrapper */
export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

/** API success response */
export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
}
