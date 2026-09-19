/**
 * Typed wrappers around the files endpoints.
 *
 * Keeping them here rather than inline in the components means the query keys,
 * the parameter names, and the response types are written once and cannot drift
 * apart between the Files app and Code Studio.
 *
 * Every call takes an optional filesystem scope. The default (undefined) is the
 * backend workspace; a host scope proxies the request to a connected host agent
 * so the operation runs against the real machine. Both scopes support list,
 * read, write, mkdir, rename, delete and download; only recursive name search is
 * workspace-only, because the agent protocol has no such call yet.
 */

import { apiDownload, apiRequest, apiUpload } from '../../lib/api-client.js';

import type { DirectoryListing, FileEntry, ReadFileResponse } from '@aether/shared';

export interface FsScope {
  scope: 'workspace' | 'host';
  agentId?: string | null;
}

/** True when the scope targets a host agent (and names one). */
export function isHostScope(fs?: FsScope): fs is { scope: 'host'; agentId: string } {
  return (
    fs !== undefined &&
    fs.scope === 'host' &&
    typeof fs.agentId === 'string' &&
    fs.agentId.length > 0
  );
}

/** Stable string for query keys, so workspace and per-agent caches never collide. */
export function fsScopeKey(fs?: FsScope): string {
  return isHostScope(fs) ? `host:${fs.agentId}` : 'workspace';
}

/** The `scope`/`agentId` query or body fields, or nothing in workspace scope. */
function scopeFields(fs?: FsScope): Record<string, string> {
  return isHostScope(fs) ? { scope: 'host', agentId: fs.agentId } : {};
}

export function listDirectory(
  path: string,
  showHidden: boolean,
  fs?: FsScope
): Promise<DirectoryListing> {
  return apiRequest<DirectoryListing>('/api/files/list', {
    query: { path, showHidden, ...scopeFields(fs) },
  });
}

export function statPath(path: string): Promise<FileEntry> {
  return apiRequest<FileEntry>('/api/files/stat', { query: { path } });
}

export function readFile(
  path: string,
  encoding?: 'utf8' | 'base64',
  fs?: FsScope
): Promise<ReadFileResponse> {
  return apiRequest<ReadFileResponse>('/api/files/read', {
    query: { path, ...(encoding !== undefined ? { encoding } : {}), ...scopeFields(fs) },
  });
}

export function writeFile(
  params: {
    path: string;
    content: string;
    encoding?: 'utf8' | 'base64';
    createOnly?: boolean;
  },
  fs?: FsScope
): Promise<FileEntry> {
  return apiRequest<FileEntry>('/api/files/write', {
    method: 'POST',
    body: {
      path: params.path,
      content: params.content,
      encoding: params.encoding ?? 'utf8',
      createOnly: params.createOnly ?? false,
      ...scopeFields(fs),
    },
  });
}

export function createDirectory(path: string, recursive = false, fs?: FsScope): Promise<FileEntry> {
  return apiRequest<FileEntry>('/api/files/mkdir', {
    method: 'POST',
    body: { path, recursive, ...scopeFields(fs) },
  });
}

export function renamePath(
  from: string,
  to: string,
  overwrite = false,
  fs?: FsScope
): Promise<FileEntry> {
  return apiRequest<FileEntry>('/api/files/rename', {
    method: 'POST',
    body: { from, to, overwrite, ...scopeFields(fs) },
  });
}

export function deletePath(path: string, recursive = false, fs?: FsScope): Promise<void> {
  return apiRequest<void>('/api/files/delete', {
    method: 'POST',
    body: { path, recursive, ...scopeFields(fs) },
  });
}

export function searchFiles(
  path: string,
  query: string,
  limit = 200
): Promise<{ results: FileEntry[]; total: number }> {
  return apiRequest<{ results: FileEntry[]; total: number }>('/api/files/search', {
    query: { path, query, limit },
  });
}

export function uploadFile(
  targetDirectory: string,
  file: File,
  fs?: FsScope,
  signal?: AbortSignal
): Promise<void> {
  return apiUpload(targetDirectory, file, scopeFields(fs), signal);
}

/**
 * Mints a ticket for the byte-serving endpoint.
 *
 * `<img>`, `<video>` and `<audio>` fetch their own `src` and cannot attach an
 * Authorization header, so the ticket travels in the URL instead. It names one
 * scope and one path, and the server refuses it for anything else — which is
 * what makes putting a credential in a URL acceptable here at all.
 */
export function requestMediaTicket(
  path: string,
  fs?: FsScope
): Promise<{ ticket: string; expiresIn: number }> {
  return apiRequest<{ ticket: string; expiresIn: number }>('/api/files/media-ticket', {
    method: 'POST',
    body: { path, ...scopeFields(fs) },
  });
}

/** Builds the URL a media element can load, given an already-issued ticket. */
export function mediaUrl(
  path: string,
  ticket: string,
  fs?: FsScope,
  options: { download?: boolean; filename?: string } = {}
): string {
  const params = new URLSearchParams({ path, ticket });
  if (isHostScope(fs)) {
    params.set('scope', 'host');
    params.set('agentId', fs.agentId);
  }
  if (options.download) params.set('download', 'true');
  if (options.filename !== undefined) params.set('name', options.filename);
  return `/api/files/raw?${params.toString()}`;
}

/**
 * Fetches a file and hands it to the browser as a download.
 *
 * The blob is created and revoked here rather than left to the caller, so a
 * download cannot leak an object URL that pins the whole file in memory.
 */
export async function downloadPath(path: string, fs?: FsScope): Promise<void> {
  const { blob, filename } = await apiDownload('/api/files/download', {
    path,
    ...scopeFields(fs),
  });
  const url = URL.createObjectURL(blob);

  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // Revoking immediately is safe: the browser has already taken a reference
    // to the blob by the time `click()` returns.
    URL.revokeObjectURL(url);
  }
}
