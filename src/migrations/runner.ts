import { Pool } from 'pg';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

/**
 * Runner di migrazioni con tracking in `schema_migrations`.
 *
 * Ogni file viene applicato AT MOST ONCE: registrato dopo l'esecuzione, così
 * migrazioni non-idempotenti (es. UPDATE di riclassificazione) non vengono
 * rieseguite a ogni boot. Ogni file gira in transazione con il proprio record.
 *
 * Compatibilità con DB pre-tracking (migrazioni già applicate a mano): se il
 * file fallisce con "already exists" lo consideriamo già applicato e lo
 * registriamo senza rieseguirlo.
 */
export async function runMigrations(
  pool: Pool,
  migrationsDir: string,
  log: (msg: string) => void = console.log
): Promise<void> {
  let files: string[];
  try {
    files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  } catch {
    log('[Migrations] No migrations directory found, skipping');
    return;
  }

  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       filename   TEXT PRIMARY KEY,
       applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
     )`
  );
  const appliedRows = await pool.query<{ filename: string }>(
    `SELECT filename FROM schema_migrations`
  );
  const applied = new Set(appliedRows.rows.map((r) => r.filename));

  log(`[Migrations] ${files.length} file totali, ${applied.size} già applicati`);

  for (const file of files) {
    if (applied.has(file)) continue;

    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
        [file]
      );
      await client.query('COMMIT');
      log(`[Migrations] ${file} - OK`);
    } catch (err: any) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.message?.includes('already exists')) {
        // Schema già presente da prima del tracking: registra come applicato
        // così non riproviamo a ogni boot.
        await pool.query(
          `INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
          [file]
        );
        log(`[Migrations] ${file} - SKIP (già presente, registrato)`);
      } else {
        client.release();
        throw new Error(`Migrazione ${file} fallita: ${err.message}`);
      }
    } finally {
      client.release();
    }
  }
  log('[Migrations] completate');
}
