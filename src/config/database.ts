import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { env } from './env';

let pool: Pool;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: env().DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    pool.on('error', (err) => {
      console.error('Unexpected database pool error:', err);
    });
  }
  return pool;
}

export async function query<T extends QueryResultRow = any>(sql: string, params?: any[]): Promise<QueryResult<T>> {
  const client = await getPool().connect();
  try {
    return await client.query<T>(sql, params);
  } finally {
    client.release();
  }
}

export async function queryOne<T extends QueryResultRow = any>(sql: string, params?: any[]): Promise<T | null> {
  const result = await query<T>(sql, params);
  return result.rows[0] || null;
}

export async function queryMany<T extends QueryResultRow = any>(sql: string, params?: any[]): Promise<T[]> {
  const result = await query<T>(sql, params);
  return result.rows;
}

export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
  }
}
