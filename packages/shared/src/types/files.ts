export type FileEntryType = 'file' | 'directory' | 'symlink' | 'socket' | 'other';

export interface FileEntry {
  /** Base name, e.g. `notes.txt`. */
  name: string;
  /** Path relative to the workspace root, POSIX separators, no leading slash. Empty string = root. */
  path: string;
  type: FileEntryType;
  /** Byte size. `0` for directories. */
  size: number;
  /** ISO-8601 mtime. */
  modifiedAt: string;
  createdAt: string;
  /** Octal permission string, e.g. `644`. */
  mode: string;
  readable: boolean;
  writable: boolean;
  /** Set when `type === 'symlink'`; relative to the link's directory. */
  symlinkTarget: string | null;
  /**
   * True when the symlink resolves outside the workspace root. Such entries are
   * listed (so the user can see they exist) but cannot be opened.
   */
  escapesWorkspace: boolean;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  /** True when the directory had more entries than the configured listing limit. */
  truncated: boolean;
}

export interface ReadFileResponse {
  path: string;
  encoding: 'utf8' | 'base64';
  content: string;
  size: number;
  /** True when the file was truncated to the configured read limit. */
  truncated: boolean;
  mimeType: string;
}

export interface WriteFileRequest {
  content: string;
  encoding?: 'utf8' | 'base64';
  /** When true the write fails if the file already exists. */
  createOnly?: boolean;
}

export interface MkdirRequest {
  path: string;
  recursive?: boolean;
}

export interface RenameRequest {
  from: string;
  to: string;
  overwrite?: boolean;
}

export interface DeleteRequest {
  path: string;
  recursive?: boolean;
}

export interface DiskUsage {
  path: string;
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}
