-- 047: Inviti guest (anche via email, senza account) + permesso a cascata
--
-- event_guests: la lista invitati di un evento. user_id è NULL quando
-- l'invitato non ha (ancora) un account MeetToo: alla registrazione con la
-- stessa email la riga viene agganciata all'account (vedi auth.service).
-- events.allow_guests_to_invite: se attivo, anche gli invitati possono
-- invitare altre persone (stile Google Calendar / Partiful).

ALTER TABLE events ADD COLUMN IF NOT EXISTS allow_guests_to_invite BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS event_guests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  email       VARCHAR(255),
  name        VARCHAR(255),
  status      VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  invited_by  UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT event_guests_identity CHECK (user_id IS NOT NULL OR email IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_guests_event_email
  ON event_guests(event_id, LOWER(email)) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_event_guests_event_user
  ON event_guests(event_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_event_guests_user
  ON event_guests(user_id) WHERE user_id IS NOT NULL;
