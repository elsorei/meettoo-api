-- 044: Ruolo consumer 'user'
--
-- La registrazione pubblica creava account con role='operator' (ruolo staff
-- del gestionale), ereditandone i privilegi: lettura delle agende altrui,
-- calendari dei "colleghi", ecc. Introduciamo il ruolo 'user' (consumer):
--   - nessun privilegio di staff;
--   - accesso ai soli eventi propri / a cui si partecipa / pubblici;
--   - free-busy e calendari altrui solo con permesso esplicito (share_permissions).
--
-- Riclassifichiamo come 'user' gli account 'operator' che non hanno un
-- record in operators: sono le registrazioni consumer avvenute finora.
-- Lo staff vero (con record operators) resta 'operator'.

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('client', 'user', 'operator', 'admin', 'owner'));

UPDATE users
   SET role = 'user', updated_at = NOW()
 WHERE role = 'operator'
   AND id NOT IN (SELECT user_id FROM operators WHERE user_id IS NOT NULL);
