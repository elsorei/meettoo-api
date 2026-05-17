import { z } from 'zod';

export const createNotificationSchema = z.object({
  userId: z.string().uuid(),
  type: z.string().min(1).max(50),
  title: z.string().max(255).optional(),
  body: z.string().optional(),
  data: z.record(z.any()).optional(),
});

export const listNotificationsQuerySchema = z.object({
  read: z.enum(['true', 'false']).optional(),
  type: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export type CreateNotificationInput = z.infer<typeof createNotificationSchema>;
