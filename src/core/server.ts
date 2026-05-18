import Fastify, { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { join } from 'path';
import { env } from '../config/env';
import { AppError, ValidationError } from './errors';

// Module route imports
import { authRoutes } from '../modules/auth/auth.routes';
import { agendaRoutes } from '../modules/agenda/agenda.routes';
import { gcalendarRoutes } from '../modules/agenda/gcalendar.routes';
import { notificationsRoutes } from '../modules/notifications/notifications.routes';
import { operatorsRoutes } from '../modules/operators/operators.routes';
import { sharingRoutes } from '../modules/sharing/sharing.routes';
import { contactsRoutes } from '../modules/contacts/contacts.routes';

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env().NODE_ENV === 'production' ? 'info' : 'debug',
      transport: env().NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
    },
    trustProxy: true,
  });

  // CORS
  const allowedOrigins = [
    /^http:\/\/localhost(:\d+)?$/, // sviluppo locale (Expo web su qualsiasi porta)
    /\.railway\.app$/,             // tutti i sottodomini Railway (dev + prod)
    /\.up\.railway\.app$/,
  ];
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true); // server-to-server / curl
      const ok = allowedOrigins.some(o => typeof o === 'string' ? o === origin : o.test(origin));
      cb(ok ? null : new Error('CORS not allowed'), ok);
    },
    credentials: true,
  });

  // Serve demo.html at root (dev only)
  if (env().NODE_ENV !== 'production') {
    await app.register(fastifyStatic, {
      root: join(__dirname, '..', '..'),
      prefix: '/demo/',
    });
  }

  // Multipart file upload
  await app.register(multipart, {
    limits: {
      fileSize: env().MAX_FILE_SIZE,
      files: 10,
    },
  });

  // Global error handler
  app.setErrorHandler((error: FastifyError | AppError, request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = (error as AppError).statusCode || error.statusCode || 500;
    const code = (error as AppError).code || 'INTERNAL_ERROR';

    if (statusCode >= 500) {
      request.log.error(error);
    }

    const response: any = {
      success: false,
      error: {
        code,
        message: error.message,
      },
    };

    if (error instanceof ValidationError && error.details) {
      response.error.details = error.details;
    }

    return reply.status(statusCode).send(response);
  });

  // Health check
  app.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.2.0',
  }));

  // One-time seed endpoint: disabled in production, creates admin ONLY if no users exist
  app.post('/api/seed-admin', async (request, reply) => {
    if (env().NODE_ENV === 'production') {
      return reply.status(404).send({ error: 'Not found' });
    }
    const { getPool } = await import('../config/database');
    const bcrypt = await import('bcrypt');
    const pool = getPool();

    // Check if any users exist
    const existing = await pool.query('SELECT COUNT(*) as cnt FROM users');
    if (parseInt(existing.rows[0].cnt) > 0) {
      return reply.status(400).send({ error: 'Users already exist. Seed disabled.' });
    }

    const body = request.body as any;
    const username = body?.username || 'admin';
    const password = body?.password || 'changeme';
    const hash = await bcrypt.hash(password, 12);

    const result = await pool.query(
      `INSERT INTO users (username, password_hash, password_version, role, is_active)
       VALUES ($1, $2, 2, 'owner', true) RETURNING id, username, role`,
      [username, hash]
    );

    // Also create operator record
    await pool.query(
      `INSERT INTO operators (user_id, email, first_name, last_name, is_admin, is_owner)
       VALUES ($1, $2, $3, $4, true, true)`,
      [result.rows[0].id, username + '@studiorei.it', 'Admin', 'StudioREI']
    );

    return { success: true, user: result.rows[0] };
  });

  // Register modules
  await app.register(authRoutes);
  await app.register(agendaRoutes);
  await app.register(gcalendarRoutes);
  await app.register(notificationsRoutes);
  await app.register(operatorsRoutes);
  await app.register(sharingRoutes);
  await app.register(contactsRoutes);

  return app;
}
