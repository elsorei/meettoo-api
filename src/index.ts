import dotenv from 'dotenv';
dotenv.config();

import { loadEnv } from './config/env';
import { buildServer } from './core/server';
import { getPool, closePool } from './config/database';
import { closeRedis } from './config/redis';
import { initSocketIO, closeSocketIO } from './core/websocket/socket';
import { initFirebase } from './core/notifications/push';
import { processScheduledImports } from './modules/accounting/accounting.service';
import { syncAllMailboxes } from './modules/email/imap.service';
import { processScheduledCommunications } from './modules/communications/communications.service';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

async function runMigrations() {
  const pool = getPool();
  const migrationsDir = join(__dirname, 'migrations');
  let files: string[];
  try {
    files = readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort();
  } catch {
    console.log('[Migrations] No migrations directory found, skipping');
    return;
  }
  console.log(`[Migrations] Found ${files.length} migration files`);
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), 'utf-8');
    try {
      await pool.query(sql);
      console.log(`[Migrations] ${file} - OK`);
    } catch (err: any) {
      if (err.message?.includes('already exists')) {
        console.log(`[Migrations] ${file} - SKIP (already applied)`);
      } else {
        console.error(`[Migrations] ${file} - ERROR: ${err.message}`);
      }
    }
  }
  console.log('[Migrations] All migrations complete');
}

async function main() {
  const config = loadEnv();
  const app = await buildServer();

  // Verify database connection
  try {
    const pool = getPool();
    const client = await pool.connect();
    const result = await client.query('SELECT NOW()');
    client.release();
    app.log.info(`Database connected: ${result.rows[0].now}`);
  } catch (err) {
    app.log.error(`Failed to connect to database: ${err}`);
    process.exit(1);
  }

  // Auto-run migrations
  try {
    await runMigrations();
  } catch (err) {
    app.log.error(`Migration error (non-fatal): ${err}`);
  }

  // Start server
  try {
    await app.listen({ port: config.PORT, host: config.HOST });
    app.log.info(`Studio REI API running on ${config.HOST}:${config.PORT}`);

    // Initialize Socket.io on the underlying HTTP server
    const httpServer = app.server;
    initSocketIO(httpServer);
    app.log.info('WebSocket (Socket.io) server ready for Blackboard');

    // Initialize Firebase for push notifications
    initFirebase();

    // Profis scheduled import checker - runs every hour
    const profisTimer = setInterval(async () => {
      try {
        const result = await processScheduledImports();
        if (result.processed > 0 || result.errors > 0) {
          app.log.info(`[Profis Scheduler] processed=${result.processed} errors=${result.errors}`);
        }
      } catch (err) {
        app.log.error(`[Profis Scheduler] ${err}`);
      }
    }, 60 * 60 * 1000); // every 1 hour

    // Store timer ref for cleanup
    (app as any)._profisTimer = profisTimer;
    app.log.info('Profis import scheduler started (check every 1h)');

    // Scheduled communications — ogni 2 minuti
    const scheduledCommTimer = setInterval(async () => {
      try {
        const result = await processScheduledCommunications();
        if (result.processed > 0 || result.errors > 0) {
          app.log.info(`[Scheduled Comms] processed=${result.processed} errors=${result.errors}`);
        }
      } catch (err) {
        app.log.error(`[Scheduled Comms] ${err}`);
      }
    }, 2 * 60 * 1000);

    (app as any)._scheduledCommTimer = scheduledCommTimer;
    app.log.info('Scheduled communications processor started (ogni 2 minuti)');

    // IMAP polling — ogni 10 minuti, solo lettura Posta Inviata
    const imapTimer = setInterval(async () => {
      try {
        const results = await syncAllMailboxes();
        const total = results.reduce((s, r) => s + r.synced, 0);
        if (total > 0) {
          app.log.info(`[IMAP Sync] ${total} nuove email abbinate a clienti`);
        }
      } catch (err) {
        app.log.error(`[IMAP Sync] ${err}`);
      }
    }, 10 * 60 * 1000); // ogni 10 minuti

    (app as any)._imapTimer = imapTimer;
    app.log.info('IMAP sync scheduler started (ogni 10 minuti, sola lettura)');

    // Prima sync al boot (dopo 30 secondi per lasciare partire il server)
    setTimeout(async () => {
      try {
        app.log.info('[IMAP Sync] Prima sync al boot...');
        const results = await syncAllMailboxes();
        const total = results.reduce((s, r) => s + r.synced, 0);
        app.log.info(`[IMAP Sync] Boot sync: ${total} email importate`);
      } catch (err) {
        app.log.error(`[IMAP Sync] Boot sync error: ${err}`);
      }
    }, 30_000);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received. Shutting down gracefully...`);
    if ((app as any)._profisTimer) clearInterval((app as any)._profisTimer);
    if ((app as any)._scheduledCommTimer) clearInterval((app as any)._scheduledCommTimer);
    if ((app as any)._imapTimer) clearInterval((app as any)._imapTimer);
    await closeSocketIO();
    await app.close();
    await closePool();
    await closeRedis();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
