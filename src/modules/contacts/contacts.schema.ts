import { z } from 'zod';

// Invio di una richiesta di contatto verso un altro utente.
export const sendRequestSchema = z.object({
  userId: z.string().uuid(),
});

// Ricerca utenti per nome, email o telefono.
export const searchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Inserisci almeno 2 caratteri').max(100),
});

// Confronto della rubrica del telefono con gli utenti Meettoo.
export const matchPhonesSchema = z.object({
  phones: z.array(z.string().min(3).max(40)).min(1).max(500),
});
