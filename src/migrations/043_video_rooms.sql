-- 043_video_rooms.sql
-- Modulo videochiamata: una sola stanza per evento (UNIQUE event_id).
-- L'host è l'utente che ha aperto la stanza (di solito l'owner dell'evento,
-- ma per gathering public_open può essere chiunque autorizzato a entrare).
--
-- Migration idempotente (CLAUDE.md regola 8).

CREATE TABLE IF NOT EXISTS video_rooms (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id      UUID UNIQUE REFERENCES events(id) ON DELETE CASCADE,
  host_user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        VARCHAR(20) NOT NULL DEFAULT 'pending', -- pending | active | ended
  started_at    TIMESTAMPTZ,
  ended_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_rooms_event_id ON video_rooms(event_id);
CREATE INDEX IF NOT EXISTS idx_video_rooms_active   ON video_rooms(status) WHERE status = 'active';
