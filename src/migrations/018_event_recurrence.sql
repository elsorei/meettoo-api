-- Aggiunge supporto per eventi ricorrenti (RRULE standard RFC 5545)
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS recurrence_rule       TEXT,
  ADD COLUMN IF NOT EXISTS recurrence_exceptions JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN events.recurrence_rule IS
  'RRULE string senza DTSTART, es: FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE;COUNT=10';
COMMENT ON COLUMN events.recurrence_exceptions IS
  'Array di date YYYY-MM-DD da saltare nella serie ricorrente';
