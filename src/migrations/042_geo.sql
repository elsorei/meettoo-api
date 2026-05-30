-- 042_geo.sql
-- Geolocalizzazione: timezone utente + location dell'evento (nome + coordinate).
-- Migration idempotente: ADD COLUMN IF NOT EXISTS + indice WHERE (vedi CLAUDE.md regola 8).

-- Timezone IANA dell'utente (es. 'Europe/Rome'). Default 'Europe/Rome' per
-- compatibilità con la base utenti italiana.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/Rome';

-- Luogo dell'evento: nome a testo libero + coordinate opzionali per la mappa.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS location_name VARCHAR(255),
  ADD COLUMN IF NOT EXISTS location_lat NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS location_lng NUMERIC(10, 7),
  ADD COLUMN IF NOT EXISTS timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/Rome';

-- Indice spaziale base (lat range query) — utile per il feed "vicino a te".
CREATE INDEX IF NOT EXISTS idx_events_location ON events(location_lat, location_lng)
  WHERE location_lat IS NOT NULL AND location_lng IS NOT NULL;
