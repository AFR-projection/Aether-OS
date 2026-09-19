/**
 * Typed wrappers around the files endpoints.
 *
 * Keeping them here rather than inline in the components means the query keys,
 * the parameter names, and the response types are written once and cannot drift
 * apart between the Files app and Code Studio.
 *
 * Every call takes an optional filesystem scope. The default (undefined) is the
 * backend workspace; a host scope proxies the request to a connected host agent
 * so the operation runs against the real machine. Host scope supports the
 * operations the agent exposes today — list, read, write, mkdir, delete — and
 * the callers disable the rest (rename, search, upload, download) for it.
 */

import { apiDownload, apiRequest, apiUpload } from '../../lib/api-client.js';

import type { DirectoryListing, FileEntry, ReadFileResponse } from '@aether/shared';

export interface FsScope {
  scope: 'workspace' | 'host';
  agentId?: string | null;
}

/** True when the scope targets a host agent (and names one). */
export function isHostScope(fs?: FsScope): fs is { scope: 'host'; agentId: string } {
  return fs !== undefined && fs.scope === 'host' && typeof fs.agentId === 'string' && fs.agentId.length > 0;
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

export function renamePath(from: string, to: string, overwrite = false): Promise<FileEntry> {
  return apiRequest<FileEntry>('/api/files/rename', {
    method: 'POST',
    body: { from, to, overwrite },
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
  signal?: AbortSignal
): Promise<void> {
  return apiUpload(targetDirectory, file, signal);
}

/**
 * Fetches a file and hands it to the browser as a download.
 *
 * The blob is created and revoked here rather than left to the caller, so a
 * download cannot leak an object URL that pins the whole file in memory.
 */
export async function downloadPath(path: string): Promise<void> {
  const { blob, filename } = await apiDownload('/api/files/download', { path });
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
