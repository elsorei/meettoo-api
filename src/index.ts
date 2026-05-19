import dotenv from 'dotenv';
dotenv.config();

import { loadEnv } from './config/env';
import { buildServer } from './core/server';
import { getPool, closePool } from './config/database';
import { closeRedis } from './config/redis';
import { initSocketIO, closeSocketIO } from './core/websocket/socket';
import { initPush } from './core/notifications/push';
import { startReminderScheduler } from './core/notifications/reminder-scheduler';
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
    app.log.info(`MeetToo API running on ${config.HOST}:${config.PORT}`);

    // Initialize Socket.io on the underlying HTTP server
    const httpServer = app.server;
    initSocketIO(httpServer);
    app.log.info('WebSocket (Socket.io) server ready');

    // Inizializza le notifiche push (servizio di Expo)
    initPush();

    // Start the reminder scheduler (checks due reminders every minute)
    startReminderScheduler();
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received. Shutting down gracefully...`);
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
