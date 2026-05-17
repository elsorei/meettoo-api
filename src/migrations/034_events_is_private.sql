-- 034_events_is_private.sql
-- Privacy per singolo evento. ADDITIVA al modello, NON distruttiva:
-- - Aggiunge boolean is_private con DEFAULT false → tutti gli eventi
--   esistenti rimangono "non privati" come prima.
-- - Il filtro applicativo (agenda.service) tratta is_private = true
--   come "visibile solo a owner / partecipanti / admin/owner",
--   nascondendolo agli altri operatori a prescindere dal livello
--   di share_permissions concesso (regola C).
-- - In parallelo (regola B), la stessa funzione di filtro tratta gli
--   eventi di tipo 'reminder' come sempre privati per non-admin
--   non-owner non-partecipanti — quella è una pura regola di codice e
--   non richiede modifica schema.

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT false;

-- Indice utile se in futuro si filtra spesso "i miei eventi privati"
-- nelle viste paginate (listEvents). Per ora non strettamente necessario
-- ma costa poco e ottimizza il caso.
CREATE INDEX IF NOT EXISTS idx_events_owner_private
  ON events(owner_id, is_private);
