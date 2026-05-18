-- 035_event_participant_reserve.sql
-- Abilita il ruolo "reserve" (riservista) tra i partecipanti di un evento.
-- Il vincolo CHECK originale (migration 001) ammetteva solo
-- organizer|participant; lo schema applicativo (Zod) accettava già
-- "reserve" ma il database lo rifiutava. Migrazione additiva:
-- nessun dato esistente viene modificato.

ALTER TABLE event_participants
  DROP CONSTRAINT IF EXISTS event_participants_role_check;

ALTER TABLE event_participants
  ADD CONSTRAINT event_participants_role_check
  CHECK (role IN ('organizer', 'participant', 'reserve'));
