/**
 * Simple SQL migration runner.
 * Usage: npx tsx src/migrations/run.ts
 *
 * Runs all .sql files in order from src/migrations/
 */
import dotenv from 'dotenv';
dotenv.config();

import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  const migrationsDir = join(__dirname);
  const files = readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();

  console.log(`Found ${files.length} migration files`);

  for (const file of files) {
    console.log(`Running: ${file}...`);
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');

    try {
      await pool.query(sql);
      console.log(`  OK`);
    } catch (err: any) {
      if (err.message?.includes('already exists')) {
        console.log(`  SKIP (already applied)`);
      } else {
        console.error(`  ERROR: ${err.message}`);
        process.exit(1);
      }
    }
  }

  console.log('All migrations complete.');
  await pool.end();
}

main();
