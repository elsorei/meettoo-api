import * as gcalService from './gcalendar.service';
import { queryOne } from '../../shared/db';

/**
 * After creating/updating an event, sync to Google Calendar if the owner has it connected.
 * Runs asynchronously - does not block the API response.
 */
export function syncEventToGCalAsync(eventId: string, ownerUserId: string): void {
  setImmediate(async () => {
    try {
      const connected = await gcalService.isConnected(ownerUserId);
      if (!connected) return;

      await gcalService.exportEvent(ownerUserId, eventId);
    } catch (err) {
      console.error(`[GCal Sync] Failed to sync event ${eventId}:`, err);
    }
  });
}

/**
 * After deleting/cancelling an event, remove from Google Calendar if synced.
 * Runs asynchronously.
 */
export function deleteEventFromGCalAsync(ownerUserId: string, gcalEventId: string | null): void {
  if (!gcalEventId) return;

  setImmediate(async () => {
    try {
      const connected = await gcalService.isConnected(ownerUserId);
      if (!connected) return;

      await gcalService.deleteGCalEvent(ownerUserId, gcalEventId);
    } catch (err) {
      console.error(`[GCal Sync] Failed to delete GCal event ${gcalEventId}:`, err);
    }
  });
}
