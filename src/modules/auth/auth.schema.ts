import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().trim().email('Email non valida'),
  password: z.string().min(1, 'Password obbligatoria'),
});

export const registerSchema = z.object({
  email: z.string().trim().email('Email non valida'),
  password: z.string().min(8, 'La password deve avere almeno 8 caratteri'),
  name: z.string().trim().min(1, 'Il nome è obbligatorio'),
  phone: z.string().trim().min(1).optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

export const forgotPasswordSchema = z.object({
  email: z.string().email('Valid email required'),
});

export const resetPasswordSchema = z.object({
  token: z.string().min(1),
  newPassword: z.string().min(8, 'Password must be at least 8 characters'),
});

export const updateProfileSchema = z.object({
  name: z.string().trim().min(1, 'Il nome non può essere vuoto').optional(),
  phone: z.string().trim().min(1).optional(),
});

export const dashboardPreferencesSchema = z.object({
  blocks: z.array(z.object({
    key: z.string(),
    visible: z.boolean(),
    order: z.number().int().min(0),
  })).max(20),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type RefreshInput = z.infer<typeof refreshSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type DashboardPreferencesInput = z.infer<typeof dashboardPreferencesSchema>;
