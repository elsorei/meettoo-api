-- 039_events_linked_event_id.sql
-- Toggle "Crea anche scadenza correlata": un evento appuntamento può generare
-- un secondo evento di tipo 'commitment' che fa da scadenza promemoria N giorni
-- prima. La FK linked_event_id collega la scadenza all'evento principale.
--
-- ON DELETE SET NULL: se l'evento principale viene cancellato, la scadenza
-- sopravvive ma perde il collegamento (decisione: l'utente la chiude a mano).
--
-- Idempotente.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS linked_event_id UUID REFERENCES events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_events_linked_event_id
  ON events(linked_event_id)
  WHERE linked_event_id IS NOT NULL;
