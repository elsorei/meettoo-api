-- 036_contacts.sql
-- Rete di contatti consumer di Meettoo: amicizie reciproche con flusso
-- richiesta -> accettazione (modello WhatsApp/Facebook).
-- Una sola riga per coppia di utenti; requester_id e addressee_id
-- indicano chi ha inviato la richiesta. Lo stato resta 'pending' finché
-- non viene accettata; il rifiuto cancella la riga (richiesta ripetibile).

CREATE TABLE IF NOT EXISTS contacts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  addressee_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'accepted')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at  TIMESTAMPTZ,
  CONSTRAINT contacts_no_self CHECK (requester_id <> addressee_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_pair
  ON contacts(requester_id, addressee_id);
CREATE INDEX IF NOT EXISTS idx_contacts_requester ON contacts(requester_id);
CREATE INDEX IF NOT EXISTS idx_contacts_addressee ON contacts(addressee_id);
