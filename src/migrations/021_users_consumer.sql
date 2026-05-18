-- 021_users_consumer.sql
-- Adatta la tabella users al modello consumer di Meettoo.
-- Nel CRM l'utente era un account astratto (username) con il profilo separato
-- in operators/clients. In Meettoo l'utente è una persona singola: email per
-- l'accesso, nome, telefono (match con la rubrica) e foto profilo.
ALTER TABLE users ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS name VARCHAR(150);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(30);
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_url VARCHAR(500);

-- Email univoca, case-insensitive. I NULL pre-esistenti restano ammessi.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users (LOWER(email));
