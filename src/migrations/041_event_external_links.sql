-- 041_event_external_links.sql
-- Sprint 3.5.1 — Link esterni associati a un evento (IG/TikTok/FB/web).
-- Non facciamo oEmbed nativo: queste sono righe semplici con metadati
-- minimi (url, titolo opzionale, immagine opzionale, sorgente) che il
-- client può arricchire con preview cards lato app.

CREATE TABLE IF NOT EXISTS event_external_links (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  url         TEXT NOT NULL,
  title       TEXT,
  image_url   TEXT,
  source      VARCHAR(20) NOT NULL DEFAULT 'web',
  position    INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_external_links_event
  ON event_external_links(event_id, position);
