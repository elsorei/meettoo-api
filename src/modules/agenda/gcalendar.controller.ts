import { FastifyRequest, FastifyReply } from 'fastify';
import * as gcalService from './gcalendar.service';
import { ValidationError, BadRequestError } from '../../core/errors';
import { AuthRequest } from '../../shared/types';

/**
 * GET /api/gcalendar/status
 * Check if the current operator has connected Google Calendar.
 */
export async function getStatus(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const connected = await gcalService.isConnected(req.user.userId);
  return reply.send({ success: true, data: { connected } });
}

/**
 * GET /api/gcalendar/connect
 * Returns the OAuth2 authorization URL. The client opens this in a browser/webview.
 */
export async function connect(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const url = gcalService.getAuthUrl(req.user.userId);
  return reply.send({ success: true, data: { authUrl: url } });
}

/**
 * GET /api/gcalendar/callback?code=xxx&state=userId
 * OAuth2 callback from Google. Exchanges code for tokens.
 */
export async function callback(request: FastifyRequest, reply: FastifyReply) {
  const { code, state } = request.query as { code?: string; state?: string };

  if (!code) throw new BadRequestError('Authorization code is required');
  if (!state) throw new BadRequestError('State (userId) is required');

  await gcalService.handleCallback(state, code);

  // Return a simple HTML page that closes itself (for webview/popup flow)
  return reply.type('text/html').send(`
    <!DOCTYPE html>
    <html>
      <head><title>Google Calendar Connected</title></head>
      <body>
        <h2>Google Calendar collegato con successo!</h2>
        <p>Puoi chiudere questa finestra.</p>
        <script>
          if (window.opener) { window.opener.postMessage('gcal_connected', '*'); window.close(); }
          setTimeout(() => window.close(), 3000);
        </script>
      </body>
    </html>
  `);
}

/**
 * POST /api/gcalendar/disconnect
 * Revoke Google Calendar access and clear tokens.
 */
export async function disconnect(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  await gcalService.disconnect(req.user.userId);
  return reply.send({ success: true, message: 'Google Calendar disconnected' });
}

/**
 * POST /api/gcalendar/export/:eventId
 * Export a single event to Google Calendar.
 */
export async function exportEvent(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { eventId } = request.params as { eventId: string };

  const gcalEventId = await gcalService.exportEvent(req.user.userId, eventId);
  return reply.send({
    success: true,
    data: { gcalEventId },
    message: 'Event exported to Google Calendar',
  });
}

/**
 * POST /api/gcalendar/import
 * Import events from Google Calendar into Studio REI.
 */
export async function importEvents(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { from, to } = request.body as { from?: string; to?: string };

  if (!from || !to) throw new ValidationError('from and to dates are required (YYYY-MM-DD)');

  const result = await gcalService.importEvents(req.user.userId, from, to);
  return reply.send({
    success: true,
    data: result,
    message: `Imported ${result.imported} events, skipped ${result.skipped}`,
  });
}

/**
 * POST /api/gcalendar/sync
 * Full bidirectional sync with Google Calendar.
 */
export async function fullSync(request: FastifyRequest, reply: FastifyReply) {
  const req = request as AuthRequest;
  const { from, to } = request.body as { from?: string; to?: string };

  if (!from || !to) throw new ValidationError('from and to dates are required (YYYY-MM-DD)');

  const result = await gcalService.fullSync(req.user.userId, from, to);
  return reply.send({
    success: true,
    data: result,
    message: `Sync complete: ${result.exported} exported, ${result.imported} imported, ${result.updated} updated`,
  });
}
