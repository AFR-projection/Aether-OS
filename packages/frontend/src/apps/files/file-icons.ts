/**
 * Maps file extensions to lucide-react icons.
 *
 * Every icon is a line icon from lucide — never emoji. The mapping is used by
 * the Files app to render recognisable type indicators in the file list and
 * grid views.
 */
import {
  File as FileIcon,
  FileCode2,
  FileJson,
  FileText,
  FileType,
  Folder,
  FolderOpen,
  Gavel,
  Image as ImageIcon,
  Lock,
  Music,
  Settings2,
  Terminal,
  Video,
  Archive,
  type LucideIcon,
} from 'lucide-react';

import type { FileEntry } from '@aether/shared';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'avif']);
const CODE_EXTS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts',
  'py', 'rb', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp',
  'cs', 'php', 'swift', 'scala', 'dart', 'lua', 'r', 'pl', 'sh', 'bash',
  'zsh', 'fish', 'ps1',
]);
const CONFIG_EXTS = new Set(['yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties']);
const ARCHIVE_EXTS = new Set(['zip', 'gz', 'tar', 'bz2', 'xz', '7z', 'rar', 'tgz']);
const VIDEO_EXTS = new Set(['mp4', 'webm', 'mkv', 'avi', 'mov']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a']);
const DOC_EXTS = new Set(['md', 'markdown', 'txt', 'log', 'rtf', 'doc', 'docx']);

const TYPE_ICONS: Record<string, LucideIcon> = {
  directory: Folder,
  symlink: Lock,
  socket: Settings2,
  other: FileIcon,
};

export function iconForEntry(entry: FileEntry): LucideIcon {
  if (entry.type !== 'file') return TYPE_ICONS[entry.type] ?? FileIcon;

  const name = entry.name.toLowerCase();
  const ext = name.includes('.') ? (name.split('.').pop() ?? '') : '';

  if (IMAGE_EXTS.has(ext)) return ImageIcon;
  if (CODE_EXTS.has(ext)) return FileCode2;
  if (ext === 'json' || ext === 'jsonc') return FileJson;
  if (CONFIG_EXTS.has(ext)) return Settings2;
  if (ARCHIVE_EXTS.has(ext)) return Archive;
  if (VIDEO_EXTS.has(ext)) return Video;
  if (AUDIO_EXTS.has(ext)) return Music;
  if (DOC_EXTS.has(ext)) return FileText;
  if (ext === 'sql') return Gavel;
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return Terminal;
  if (ext === '') return FileType;

  return FileIcon;
}

/**
 * Icons for the tree view, where open/closed state affects the glyph.
 */
export function treeIconForEntry(entry: FileEntry, open?: boolean): LucideIcon {
  if (entry.type === 'directory') return open ? FolderOpen : Folder;
  return iconForEntry(entry);
}

/** Whether the entry is an image the app can render inline. */
export function isImageFile(entry: FileEntry): boolean {
  if (entry.type !== 'file') return false;
  const ext = entry.name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTS.has(ext);
}
