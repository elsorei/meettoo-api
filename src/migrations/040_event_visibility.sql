-- 040_event_visibility.sql
-- Sprint 3.5.1 — Evento "post-style": aggiungere visibilità a scaglioni,
-- estendere events.type con 'gathering' (4° tipo), e legare una cover
-- (opzionale) a uno degli event_attachments.
--
-- Migration idempotente: i blocchi DO $$ e gli IF NOT EXISTS la rendono
-- sicura da rieseguire (vedi CLAUDE.md regola 8).
--
-- Nota su events.type: nello schema iniziale (001) `type` è un VARCHAR(20)
-- con CHECK constraint (NOT un ENUM Postgres). Quindi per ammettere
-- 'gathering' va dropato il CHECK auto-generato (events_type_check) e
-- ricreato con il nuovo set di valori.

-- ── 1. Enum visibility ──
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'event_visibility') THEN
    CREATE TYPE event_visibility AS ENUM (
      'private',
      'invitees',
      'friends',
      'public_view',
      'public_open'
    );
  END IF;
END $$;

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS visibility event_visibility NOT NULL DEFAULT 'invitees';

-- ── 2. Estendere events.type con 'gathering' (CHECK constraint, non ENUM) ──
-- Drop del CHECK esistente solo se contiene la vecchia lista (senza
-- 'gathering'); altrimenti la migration è già stata applicata.
DO $$
DECLARE
  current_def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO current_def
  FROM pg_constraint
  WHERE conname = 'events_type_check'
    AND conrelid = 'events'::regclass;

  IF current_def IS NOT NULL AND position('gathering' in current_def) = 0 THEN
    ALTER TABLE events DROP CONSTRAINT events_type_check;
    ALTER TABLE events
      ADD CONSTRAINT events_type_check
      CHECK (type IN ('appointment','commitment','reminder','gathering'));
  END IF;
END $$;

-- ── 3. Cover: FK opzionale verso event_attachments ──
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS cover_attachment_id UUID
    REFERENCES event_attachments(id) ON DELETE SET NULL;

-- ── 4. Indice per il feed pubblico ──
-- Filtra solo gli eventi pubblici, ordinati per data discendente.
CREATE INDEX IF NOT EXISTS idx_events_visibility_public
  ON events(visibility, event_date DESC)
  WHERE visibility IN ('public_view','public_open');
