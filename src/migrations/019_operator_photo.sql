-- Aggiunge foto profilo agli operatori (base64 data URL, max ~150KB)
ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS photo TEXT;

COMMENT ON COLUMN operators.photo IS 'Base64 data URL della foto profilo (es: data:image/jpeg;base64,...)';
