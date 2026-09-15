/**
 * Typed wrappers around the files endpoints.
 *
 * Keeping them here rather than inline in the components means the query keys,
 * the parameter names, and the response types are written once and cannot drift
 * apart between the Files app and Code Studio.
 */

import { apiDownload, apiRequest, apiUpload } from '../../lib/api-client.js';

import type { DirectoryListing, FileEntry, ReadFileResponse } from '@aether/shared';


export function listDirectory(path: string, showHidden: boolean): Promise<DirectoryListing> {
  return apiRequest<DirectoryListing>('/api/files/list', {
    query: { path, showHidden },
  });
}

export function statPath(path: string): Promise<FileEntry> {
  return apiRequest<FileEntry>('/api/files/stat', { query: { path } });
}

export function readFile(path: string, encoding?: 'utf8' | 'base64'): Promise<ReadFileResponse> {
  return apiRequest<ReadFileResponse>('/api/files/read', {
    query: { path, ...(encoding !== undefined ? { encoding } : {}) },
  });
}

export function writeFile(params: {
  path: string;
  content: string;
  encoding?: 'utf8' | 'base64';
  createOnly?: boolean;
}): Promise<FileEntry> {
  return apiRequest<FileEntry>('/api/files/write', {
    method: 'POST',
    body: {
      path: params.path,
      content: params.content,
      encoding: params.encoding ?? 'utf8',
      createOnly: params.createOnly ?? false,
    },
  });
}

export function createDirectory(path: string, recursive = false): Promise<FileEntry> {
  return apiRequest<FileEntry>('/api/files/mkdir', {
    method: 'POST',
    body: { path, recursive },
  });
}

export function renamePath(from: string, to: string, overwrite = false): Promise<FileEntry> {
  return apiRequest<FileEntry>('/api/files/rename', {
    method: 'POST',
    body: { from, to, overwrite },
  });
}

export function deletePath(path: string, recursive = false): Promise<void> {
  return apiRequest<void>('/api/files/delete', {
    method: 'POST',
    body: { path, recursive },
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
