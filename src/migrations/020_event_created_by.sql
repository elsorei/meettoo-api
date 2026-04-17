-- Traccia chi ha creato/assegnato un evento (può differire dall'owner dell'agenda)
ALTER TABLE events ADD COLUMN IF NOT EXISTS created_by_id UUID REFERENCES users(id);
