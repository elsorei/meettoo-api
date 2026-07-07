-- 046: Cancellazione account (GDPR)
-- deleted_at marca gli account cancellati dall'utente. Il record resta
-- (gli eventi passati riferiscono owner_id) ma viene anonimizzato:
-- email/nome/telefono/foto rimossi, credenziali invalidate.

ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
