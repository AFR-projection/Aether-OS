import { z } from 'zod';

import { emailSchema, passwordSchema, usernameSchema, uuidSchema } from './common.schema.js';

export const loginRequestSchema = z.object({
  username: z.string().min(1, 'Username is required').max(64),
  // Deliberately *not* passwordSchema: an existing password may predate a rule
  // change, and a length error here would leak whether an account exists.
  password: z.string().min(1, 'Password is required').max(256),
});
export type LoginRequestInput = z.infer<typeof loginRequestSchema>;

export const refreshRequestSchema = z.object({
  refreshToken: z.string().min(1).max(4096),
});
export type RefreshRequestInput = z.infer<typeof refreshRequestSchema>;

export const bootstrapRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  email: emailSchema.optional(),
});
export type BootstrapRequestInput = z.infer<typeof bootstrapRequestSchema>;

export const createUserRequestSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  email: emailSchema.optional(),
  role: z.enum(['owner', 'admin', 'operator', 'viewer']),
});
export type CreateUserRequestInput = z.infer<typeof createUserRequestSchema>;

export const updateUserRequestSchema = z
  .object({
    email: emailSchema.nullable().optional(),
    role: z.enum(['owner', 'admin', 'operator', 'viewer']).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'At least one field must be provided');
export type UpdateUserRequestInput = z.infer<typeof updateUserRequestSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});
export type ChangePasswordRequestInput = z.infer<typeof changePasswordRequestSchema>;

export const sessionIdParamSchema = z.object({ id: uuidSchema });
export const userIdParamSchema = z.object({ id: uuidSchema });

/** Response shape for `GET /api/auth/sessions`. */
export const authSessionSchema = z.object({
  id: uuidSchema,
  userAgent: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  current: z.boolean(),
});

export const listSessionsResponseSchema = z.array(authSessionSchema);
