/**
 * Re-export database utilities for convenient imports:
 *   import { query, queryOne, queryMany, transaction } from '@shared/db';
 */
export { query, queryOne, queryMany, transaction, getPool, closePool } from '../config/database';
