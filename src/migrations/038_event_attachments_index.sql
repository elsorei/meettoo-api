-- 038_event_attachments_index.sql
-- Aggiunge indici di lookup sulla tabella event_attachments creata in
-- 001_initial_schema.sql. Senza questi indici, la lettura degli allegati
-- di un evento e l'ordinamento cronologico fanno seq scan.
--
-- Idempotente: usa IF NOT EXISTS.

CREATE INDEX IF NOT EXISTS idx_event_attachments_event
  ON event_attachments(event_id);

-- Indice composito per la lista ordinata "più recenti prima" usata
-- dall'endpoint GET /api/events/:id/attachments.
CREATE INDEX IF NOT EXISTS idx_event_attachments_event_created
  ON event_attachments(event_id, created_at DESC);
