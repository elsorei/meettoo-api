import { z } from 'zod';

export const createOperatorSchema = z.object({
  email: z.string().email('Valid email required'),
  firstName: z.string().min(1, 'First name is required').max(100),
  lastName: z.string().min(1, 'Last name is required').max(100),
  department: z.string().max(100).optional(),
  isAdmin: z.boolean().default(false),
  password: z.string().min(8).optional(),
  sendCredentials: z.boolean().default(false),
});

export const updateOperatorSchema = z.object({
  email: z.string().email().optional(),
  firstName: z.string().min(1).max(100).optional(),
  lastName: z.string().min(1).max(100).optional(),
  department: z.string().max(100).optional().nullable(),
  isAdmin: z.boolean().optional(),
});

export const listOperatorsQuerySchema = z.object({
  search: z.string().optional(),
  department: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type CreateOperatorInput = z.infer<typeof createOperatorSchema>;
export type UpdateOperatorInput = z.infer<typeof updateOperatorSchema>;
