-- 037_event_reminder.sql
-- Promemoria evento: "avvisami N minuti prima". Memorizziamo lo SCARTO in
-- minuti (alarm_minutes_before), non un orario fisso: così se l'evento
-- viene spostato il promemoria lo segue da solo. alarm_sent_at marca
-- l'invio, perché il promemoria parta una volta sola.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS alarm_minutes_before INTEGER,
  ADD COLUMN IF NOT EXISTS alarm_sent_at TIMESTAMPTZ;

-- Indice parziale per la scansione periodica dei promemoria da inviare.
CREATE INDEX IF NOT EXISTS idx_events_reminder_pending
  ON events (event_date, start_time)
  WHERE alarm_minutes_before IS NOT NULL AND alarm_sent_at IS NULL;
