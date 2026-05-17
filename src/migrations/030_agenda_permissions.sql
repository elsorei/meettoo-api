-- ============================================
-- AGENDA / TODO SHARING PERMISSIONS
-- ============================================
-- Permette a un operatore di concedere accesso al proprio calendario
-- (e/o todo list) a un collega con uno di tre livelli:
--   - ghost  → vede solo "Occupato" senza dettagli (default tra operator)
--   - white  → vede titolo, descrizione, partecipanti (read-only)
--   - write  → può anche modificare/eliminare
--
-- Admin e owner vedono SEMPRE tutto (white-equivalent) senza bisogno
-- di entry esplicite in questa tabella.

CREATE TABLE IF NOT EXISTS share_permissions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_type   VARCHAR(20) NOT NULL CHECK (resource_type IN ('agenda', 'todo')),
  -- chi concede l'accesso al proprio resource (calendario/todo)
  grantor_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- chi riceve l'accesso
  grantee_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level           VARCHAR(10) NOT NULL CHECK (level IN ('ghost', 'white', 'write')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- un solo livello per coppia (grantor, grantee, resource_type)
  UNIQUE (resource_type, grantor_user_id, grantee_user_id),
  -- non si può concedere a se stessi
  CHECK (grantor_user_id <> grantee_user_id)
);

CREATE INDEX IF NOT EXISTS idx_share_perm_grantee
  ON share_permissions(grantee_user_id, resource_type);

CREATE INDEX IF NOT EXISTS idx_share_perm_grantor
  ON share_permissions(grantor_user_id, resource_type);
