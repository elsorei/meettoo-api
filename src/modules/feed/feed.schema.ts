import { z } from 'zod';

// Feed pubblico: solo lettura. Filtri opzionali per range data e paginazione.
export const listPublicFeedQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD').optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD').optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ListPublicFeedQuery = z.infer<typeof listPublicFeedQuerySchema>;
