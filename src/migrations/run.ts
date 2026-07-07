/**
 * Simple SQL migration runner (manuale).
 * Usage: npx tsx src/migrations/run.ts
 *
 * Applica i .sql non ancora registrati in schema_migrations (vedi runner.ts).
 */
import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { join } from 'path';
import { runMigrations } from './runner';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await runMigrations(pool, join(__dirname));
  } catch (err: any) {
    console.error(err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
