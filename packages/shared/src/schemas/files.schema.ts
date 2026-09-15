import { z } from 'zod';

import { queryBooleanSchema, relativePathSchema } from './common.schema.js';

/** Query for `GET /api/files/list`. An empty path means the workspace root. */
export const listDirectoryQuerySchema = z.object({
  path: z.union([relativePathSchema, z.literal('')]).default(''),
  /** Include dotfiles. Defaults to true — this is the user's own machine. */
  showHidden: queryBooleanSchema.default(true),
});
export type ListDirectoryQuery = z.infer<typeof listDirectoryQuerySchema>;

export const readFileQuerySchema = z.object({
  path: relativePathSchema,
  encoding: z.enum(['utf8', 'base64']).optional(),
});
export type ReadFileQuery = z.infer<typeof readFileQuerySchema>;

export const writeFileBodySchema = z.object({
  path: relativePathSchema,
  content: z.string().max(5 * 1024 * 1024, 'Inline writes are limited to 5 MiB'),
  encoding: z.enum(['utf8', 'base64']).default('utf8'),
  createOnly: z.boolean().default(false),
});
export type WriteFileBody = z.infer<typeof writeFileBodySchema>;

export const mkdirBodySchema = z.object({
  path: relativePathSchema,
  recursive: z.boolean().default(false),
});
export type MkdirBody = z.infer<typeof mkdirBodySchema>;

export const renameBodySchema = z.object({
  from: relativePathSchema,
  to: relativePathSchema,
  overwrite: z.boolean().default(false),
});
export type RenameBody = z.infer<typeof renameBodySchema>;

export const deleteBodySchema = z.object({
  path: relativePathSchema,
  recursive: z.boolean().default(false),
});
export type DeleteBody = z.infer<typeof deleteBodySchema>;

export const downloadQuerySchema = z.object({
  path: relativePathSchema,
});
export type DownloadQuery = z.infer<typeof downloadQuerySchema>;

export const searchQuerySchema = z.object({
  /** Directory to search, relative to the workspace root. */
  path: z.union([relativePathSchema, z.literal('')]).default(''),
  /** Case-insensitive substring match against entry names. */
  query: z.string().min(1).max(256),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

/**
 * A single path segment used as a file name.
 *
 * Rejects separators and dot-only names so a caller cannot use the upload
 * endpoint to write outside the directory it named.
 */
export const fileNameSchema = z
  .string()
  .min(1, 'File name is required')
  .max(255, 'File name is too long')
  .refine((value) => !value.includes('\0'), 'File name must not contain NUL bytes')
  .refine((value) => !/[\\/]/.test(value), 'File name must not contain path separators')
  .refine((value) => value !== '.' && value !== '..', 'File name is not allowed');

/** Query for `POST /api/files/upload` — target directory plus file name. */
export const uploadQuerySchema = z.object({
  path: z.union([relativePathSchema, z.literal('')]).default(''),
  name: fileNameSchema,
});
export type UploadQuery = z.infer<typeof uploadQuerySchema>;
